import Listeners from '/js/listeners.js\
?tabs.onActivated\
&tabs.onCreated\
&tabs.onUpdated\
&tabs.onRemoved\
&tabs.onMoved\
&tabs.onDetached\
&tabs.onAttached\
&storage.local.onChanged\
';
import './prefixed-storage.js';
import Logger from './logger.js';
import Notification from './notification.js';
import BatchProcessor from './batch-processor.js';
import * as Broadcast from './broadcast.js';
import * as TabsBroadcast from './broadcast.js?channel=tabs';
import * as Constants from './constants.js';
import * as Utils from './utils.js';
import * as Cache from './cache.js';
import * as Containers from './containers.js';
import * as Extensions from './extensions.js';
import * as Groups from './groups.js';
import * as SubGroups from './sub-groups.js';
import * as Operations from './operations.js';
import * as Windows from './windows.js';
import * as ConstantsBrowser from './constants-browser.js';
import * as Storage from './storage.js';
import * as BrowserSettings from './browser-settings.js';

export {on, off} from './broadcast.js?channel=tabs';

const logger = new Logger('Tabs');
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const settings = await Storage.get(['showTabsWithThumbnailsInManageGroups', 'colorScheme']);
Cache.setUseThumbnails(settings.showTabsWithThumbnailsInManageGroups);
const skipTrackingWindows = new Set();
const skip = {
    created: new Set(),
    tracking: new Set(),
    removed: new Set(),
};
const pendingRealUrls = new Map();

Listeners.storage.local.onChanged.add(onStorageChanged, {waitListener: false});

export function addListeners(options) {
    Listeners.tabs.onActivated.add(onActivated, options);
    Listeners.tabs.onCreated.add(onCreated, options);
    Listeners.tabs.onUpdated.add(onUpdated, options);
    Listeners.tabs.onRemoved.add(onRemoved, options);
    Listeners.tabs.onMoved.add(onMoved, options);
    Listeners.tabs.onDetached.add(onDetached, options);
    Listeners.tabs.onAttached.add(onAttached, options);
}

export function removeListeners() {
    Listeners.tabs.onActivated.remove(onActivated);
    Listeners.tabs.onCreated.remove(onCreated);
    Listeners.tabs.onUpdated.remove(onUpdated);
    Listeners.tabs.onRemoved.remove(onRemoved);
    Listeners.tabs.onMoved.remove(onMoved);
    Listeners.tabs.onDetached.remove(onDetached);
    Listeners.tabs.onAttached.remove(onAttached);
}

function send(action, data) {
    TabsBroadcast.send({action, ...data}, {
        includeSelf: false,
    });
}

export function sendUpdatedGroup(groupId) {
    send('updated.group', { groupId });
}

const deferredUpdatedKeys = new Set;

function unsyncKey(windowId) {
    return `unsync:${windowId}`;
}

function updatedKey(groupId, windowId) {
    return groupId || unsyncKey(windowId);
}

const updatedBatch = new BatchProcessor(async (tabIds, groupKey) => {
    if (Operations.isBusy()) {
        deferredUpdatedKeys.add(groupKey);
        return;
    }

    if (groupKey.startsWith('unsync:')) {
        const windowId = Number(groupKey.split(':', 2)[1]);
        send('updated.unsync', {windowId});
        return;
    }

    const {group} = await Groups.load(groupKey);
    if (group) {
        sendUpdatedGroup(groupKey);
    }
});

Operations.onIdle(function sendDeferredUpdated() {
    for (const groupKey of deferredUpdatedKeys) {
        updatedBatch.add(groupKey, groupKey);
    }
    deferredUpdatedKeys.clear();
});

export function skipTrackingWindow(windowId) {
    skipTrackingWindows.add(windowId);
}

export function continueTrackingWindow(windowId) {
    skipTrackingWindows.delete(windowId);
}

export function skipTrackingTabs(tabs, accum = new Set) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.add(id);
        accum.add(id);
    }
    return accum;
}

export function continueTrackingTabs(tabs, accum = null) {
    for (const tab of tabs) {
        const id = extractId(tab);
        skip.tracking.delete(id);
        accum?.delete(id);
    }
}

export function isSkippedTracking(tab) {
    return skip.tracking.has(extractId(tab));
}

const pendingOnCreatedById = new Map();

async function onCreated(tab) {
    const tabId = tab.id;
    const {promise, resolve} = Promise.withResolvers();

    pendingOnCreatedById.set(tabId, promise);

    try {
        await processCreated(tab);
    } catch (error) {
        logger.logError(['onCreated failed for tab:', tabId], error);
    } finally {
        pendingOnCreatedById.delete(tabId);
        resolve();
    }
}

export function waitOnCreated(tabId) {
    return pendingOnCreatedById.get(tabId) ?? Promise.resolve();
}

async function processCreated(tab) {
    await Utils.wait(30); // Optimized wait interval

    const skipCreated = skip.created.delete(tab.id);

    if (skip.removed.has(tab.id) || skipTrackingWindows.has(tab.windowId)) {
        return;
    }

    if (!isPinned(tab)) {
        SubGroups.scheduleMirrorWindow(tab.windowId);
    }

    if (skipCreated) {
        return;
    }

    browserTabToAddon(tab);
    Cache.setTab(tab);

    if (isPinned(tab)) return;

    await Cache.setTabGroup(tab.id, null, tab.windowId)
        .catch(logger.onCatch("onCreated can't set group", false));

    Cache.applyTabSession(tab);
    updatedBatch.add(tab.id, updatedKey(tab.groupId, tab.windowId));
}

async function onActivated({tabId, windowId, previousTabId = null}) {
    await Utils.wait(50);

    if (skip.tracking.has(tabId) || skip.tracking.has(previousTabId) || skipTrackingWindows.has(windowId)) {
        return;
    }

    if (!skip.removed.has(tabId)) {
        send('updated', { tabId, changeInfo: {active: true} });
    }

    if (previousTabId && !skip.removed.has(previousTabId)) {
        send('updated', { tabId: previousTabId, changeInfo: {active: false} });
    }
}

async function processPendingRealUrls(tabId, changeInfo) {
    if (pendingRealUrls.has(tabId) && isLoaded(changeInfo)) {
        sendMessage(tabId, {
            action: 'real-url',
            url: pendingRealUrls.get(tabId),
        }).finally(() => pendingRealUrls.delete(tabId));
    }
}

async function onUpdated(tabId, changeInfo, tab) {
    if (skip.removed.has(tab.id)) return;

    processPendingRealUrls(tabId, changeInfo);
    browserTabToAddon(tab);

    if (skip.tracking.has(tab.id) || skipTrackingWindows.has(tab.windowId)) {
        Cache.setTab(tab, changeInfo);
        if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
            updatedBatch.add(tab.id, updatedKey(Cache.getTabGroup(tab.id), tab.windowId));
        }
        return;
    }

    if (!Object.hasOwn(changeInfo, 'groupId') && !Constants.ON_UPDATED_TAB_PROPERTIES.some(key => Object.hasOwn(changeInfo, key))) {
        Cache.mirrorTab(tab);
        return;
    }

    await Utils.wait(60);

    if (skip.tracking.has(tab.id)) return;

    tab = await get(tabId, {withSession: false});
    if (!tab) return;

    const log = logger.start(onUpdated, tabId, changeInfo);
    const announced = changeInfo;
    changeInfo = Cache.getRealTabStateChanged(tab);
    Cache.setTab(tab, announced);

    if (!changeInfo) {
        log.stop('🛑 changeInfo keys have not changed');
        return;
    }

    if (isPinned(tab) && !Object.hasOwn(changeInfo, 'pinned')) {
        log.stop('🛑 tab is pinned');
        return;
    }

    if (Utils.isAvailableFavIconUrl(tab.favIconUrl)) {
        if (changeInfo.favIconUrl) {
            await Cache.setTabFavIcon(tab.id, changeInfo.favIconUrl)
                .catch(log.onCatch(['cant set favIcon', tab, changeInfo], false));
        }
    } else if (isLoaded(tab) && !tab.discarded) {
        await Cache.removeTabFavIcon(tab.id);
        changeInfo.favIconUrl = null;
    }

    if (Object.hasOwn(changeInfo, 'pinned') || Object.hasOwn(changeInfo, 'hidden')) {
        let tabGroupId;
        if (changeInfo.pinned || changeInfo.hidden) {
            tabGroupId = Cache.getTabGroup(tab.id);
            await Cache.removeTabGroup(tab.id);
            if (changeInfo.pinned) {
                await Cache.removeTabSubGroupId(tab.id);
            }
        } else if (changeInfo.pinned === false) {
            await Cache.setTabGroup(tab.id, null, tab.windowId)
                .catch(log.onCatch(["can't set group to tab, !pinned", tab.id], false));
            tabGroupId = Cache.getTabGroup(tab.id);
        } else if (changeInfo.hidden === false) {
            Cache.applyTabSession(tab);
            if (tab.groupId) {
                await Groups.apply(tab.windowId, tab.groupId, tab.id)
                    .catch(log.onCatch(["can't apply group", tab.groupId], false));
            } else {
                await Cache.setTabGroup(tab.id, null, tab.windowId)
                    .catch(log.onCatch(["can't set group to tab, !hidden", tab.id], false));
                tabGroupId = Cache.getTabGroup(tab.id);
            }
        }

        tabGroupId && updatedBatch.add(tab.id, tabGroupId);
        updatedBatch.add(tab.id, unsyncKey(tab.windowId));
        log.stop();
        return;
    }

    send('updated', { tabId: tab.id, changeInfo });

    if (isLoaded(changeInfo)) {
        await updateThumbnail(tab.id);
    }

    log.stop();
}

function onRemoved(tabId, {isWindowClosing, windowId}) {
    const silent = skip.removed.has(tabId);
    skip.removed.add(tabId);
    skip.created.delete(tabId);

    const groupId = Cache.getTabGroup(tabId);
    const groupKey = updatedKey(groupId, windowId);

    if (silent) {
        Cache.removeTab(tabId);
        updatedBatch.add(tabId, groupKey);
        return;
    }

    updatedBatch.delete(tabId, groupKey);

    if (skipTrackingWindows.has(windowId)) return;

    if (isWindowClosing) {
        Broadcast.send({ action: 'add-restore-tab-on-removed-window', tabId });
    } else {
        Cache.removeTab(tabId);
        if (groupId) {
            send('removed', { tabId, groupId });
        } else {
            send('removed.unsync', { tabId });
        }
    }
}

async function onMoved(tabId, {windowId, fromIndex, toIndex}) {
    if (skip.removed.has(tabId)) return;

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), windowId));
        return;
    }

    if (skipTrackingWindows.has(windowId)) return;

    const groupId = Cache.getTabGroup(tabId);
    updatedBatch.add(tabId, updatedKey(groupId, windowId));
    SubGroups.scheduleMirrorWindow(windowId);
}

async function onDetached(tabId, {oldWindowId}) {
    Cache.clearTabOpeners(tabId);

    if (skip.removed.has(tabId)) return;

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), oldWindowId));
        return;
    }

    const groupId = Cache.getWindowGroup(oldWindowId);
    updatedBatch.add(tabId, updatedKey(groupId, oldWindowId));
    SubGroups.scheduleMirrorWindow(oldWindowId);
}

async function onAttached(tabId, {newWindowId}) {
    if (skip.removed.has(tabId)) return;

    if (skip.tracking.has(tabId)) {
        updatedBatch.add(tabId, updatedKey(Cache.getTabGroup(tabId), newWindowId));
        return;
    }

    const log = logger.start(onAttached, {tabId, newWindowId});
    await Cache.setTabGroup(tabId, null, newWindowId).catch(log.onCatch("can't set group"));

    const attachedTab = await get(tabId, {raw: true});
    if (attachedTab?.groupId === SubGroups.TAB_GROUP_ID_NONE) {
        await Cache.removeTabSubGroupId(tabId);
    }

    const groupId = Cache.getTabGroup(tabId);
    updatedBatch.add(tabId, updatedKey(groupId, newWindowId));
    SubGroups.scheduleMirrorWindow(newWindowId);

    if (groupId && attachedTab?.mutedInfo.muted && !attachedTab.hidden) {
        const {group} = await Groups.load(groupId);
        await Groups.showTabs(group, [attachedTab]);
    }
    log.stop();
}

function onStorageChanged(changes) {
    if (Storage.isChangedKey('showTabsWithThumbnailsInManageGroups', changes, Boolean)) {
        settings.showTabsWithThumbnailsInManageGroups = changes.showTabsWithThumbnailsInManageGroups.newValue;
        Cache.setUseThumbnails(settings.showTabsWithThumbnailsInManageGroups);
    }
    if (Storage.isChangedKey('colorScheme', changes, String)) {
        settings.colorScheme = changes.colorScheme.newValue;
    }
}

export async function create({url, active, pinned, title, index, windowId, openerTabId, cookieStoreId, newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen, groupId, subGroupId, favIconUrl, thumbnail}, params = {}) {
    const schema = tabsActionSchema.get('create');
    const skipTrackingCreated = params.skipTrackingCreated ?? schema.skipTrackingCreated ?? false;
    const allowDiscarded = params.allowDiscarded ?? true;

    if (!Constants.IS_BACKGROUND_PAGE) {
        throw new Error('is not background');
    }

    const tab = {};
    const {url: createUrl, realUrl, openInReaderMode} = prepareUrlForCreate(url);

    if (createUrl) tab.url = createUrl;
    tab.active = !!active;
    if (pinned) tab.pinned = true;
    if (openInReaderMode) tab.openInReaderMode = true;

    if (allowDiscarded && !tab.active && !tab.pinned && tab.url && !tab.url.startsWith('about:') && !realUrl && !openInReaderMode) {
        tab.discarded = true;
    }

    if (tab.discarded && title) tab.title = title.slice(0, 1000);
    if (Number.isSafeInteger(index) && index >= 0) tab.index = index;

    windowId = Cache.getWindowId(groupId) || windowId;
    if (Number.isSafeInteger(windowId) && windowId > 0) tab.windowId = windowId;
    if (Number.isSafeInteger(openerTabId) && openerTabId > 0) tab.openerTabId = openerTabId;

    tab.cookieStoreId = cookieStoreId || Constants.DEFAULT_COOKIE_STORE_ID;
    tab.cookieStoreId = getNewTabContainer(tab, {newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen});

    if (tab.cookieStoreId === Constants.TEMPORARY_CONTAINER) {
        tab.cookieStoreId = (await Containers.createTemporary()).cookieStoreId;
    } else {
        tab.cookieStoreId = Containers.get(tab.cookieStoreId).cookieStoreId;
    }

    const newTab = await browser.tabs.create(tab);
    if (skipTrackingCreated) skip.created.add(newTab.id);

    browserTabToAddon(newTab);
    if (realUrl) {
        pendingRealUrls.set(newTab.id, realUrl);
        self.setTimeout(() => pendingRealUrls.delete(newTab.id), 30_000);
    }

    if (createUrl) {
        Cache.setTabRequestedUrl(newTab.id, urlToAddon(url));
    }

    fillEmptyUrl(newTab);
    await Cache.setTabSession(newTab, {groupId, subGroupId, favIconUrl, thumbnail});
    return newTab;
}

export function wrapUnsupportedUrl(url) {
    return `${Constants.PAGES.HELP.UNSUPPORTED_URL}?${new URLSearchParams({url})}`;
}

function unwrapUrl(url) {
    return Extensions.isWrapperUrl(url) ? Utils.getNestedUrl(url) ?? url : url;
}

function prepareUrlForCreate(url) {
    const readerPageUrl = getPageUrl(url);
    const openInReaderMode = readerPageUrl !== url && readerPageUrl.startsWith('http');
    const pageUrl = openInReaderMode ? readerPageUrl : url;

    if (!pageUrl || pageUrl === 'about:newtab' || pageUrl === 'about:home') return {};

    const result = {};
    let createUrl;

    if (Utils.isDataUrlAllowToNavigate(pageUrl)) {
        result.realUrl = pageUrl;
        createUrl = Constants.PAGES.HELP.DUMMY;
    } else {
        createUrl = Extensions.urlToBrowserOrNull(pageUrl) ?? wrapUnsupportedUrl(pageUrl);
    }

    if (!Utils.isUrlLengthValid(createUrl)) {
        result.realUrl = pageUrl;
        createUrl = Constants.PAGES.HELP.UNSUPPORTED_URL;
    }

    result.url = createUrl;
    if (openInReaderMode && createUrl.startsWith('http')) result.openInReaderMode = true;
    return result;
}

export async function createMultiple(tabsToCreate, params = {}) {
    const startIndex = params.startIndex ?? null;
    const createMissing = params.createMissing ?? false;
    const hideUnloaded = params.hideUnloaded ?? true;

    if (!Array.isArray(tabsToCreate)) throw new Error('tabs must be an array');

    const newTabs = createMissing ? tabsToCreate.filter(tab => tab?.new) : tabsToCreate;
    if (!newTabs.length) {
        const aligned = tabsToCreate.map(tab => tab?.new ? undefined : tab);
        return {created: [], live: aligned.filter(Boolean), aligned};
    }

    const placements = [];
    const nextIndexByWindow = new Map();
    let fallbackWindowId = null;

    for (const [index, tab] of newTabs.entries()) {
        const windowId = Cache.getWindowId(tab.groupId) || tab.windowId || (fallbackWindowId ??= await Windows.getFirstNormalWindowId());
        if (tab.pinned) {
            placements[index] = {windowId};
            continue;
        }

        const tabIndex = nextIndexByWindow.get(windowId) ?? startIndex ?? (await browser.tabs.query({windowId})).length;
        nextIndexByWindow.set(windowId, tabIndex + 1);
        placements[index] = {windowId, index: tabIndex, active: false};
    }

    let created = await Promise.all(newTabs.map(async (tab, index) => {
        try {
            return await create({ ...tab, ...placements[index], openerTabId: undefined });
        } catch (error) {
            return undefined;
        }
    }));

    const createdTabsByWindow = Map.groupBy(created.filter(Boolean), tab => tab.windowId);
    for (const windowTabs of createdTabsByWindow.values()) {
        const sorted = await ensureSorted(windowTabs, {...params, byMinIndex: true});
        const sortedById = new Map(sorted.map(tab => [tab.id, tab]));
        created = created.map(tab => sortedById.has(tab?.id) ? Cache.applyTabSession(sortedById.get(tab.id)) : tab);
    }

    for (const [index, tab] of created.entries()) {
        if (newTabs[index].active === true && tab && !tab.active) {
            await setActive(tab.id);
        }
    }

    if (hideUnloaded) {
        await hide(created.filter(tab => tab?.groupId && !Cache.getWindowId(tab.groupId)), {ungroupNative: startIndex !== null});
    }

    let next = 0;
    const aligned = createMissing ? tabsToCreate.map(tab => tab?.new ? created[next++] : tab) : created;

    return {
        created: created.filter(Boolean),
        live: aligned.filter(Boolean),
        aligned,
    };
}

export function getOpenersByOffset(fromTabs, toTabs = fromTabs) {
    if (fromTabs.length !== toTabs.length) throw new Error('fromTabs and toTabs must have the same length');
    const openers = new Map;
    for (const [index, tab] of fromTabs.entries()) {
        if (tab?.openerOffset && toTabs[index]) {
            openers.set(toTabs[index], toTabs[index + tab.openerOffset]);
        }
    }
    return openers;
}

export function getOpenersById(tabs) {
    const openers = new Map;
    const byId = new Map(tabs.map(tab => [tab?.id, tab]));
    for (const tab of tabs) {
        if (tab?.openerTabId > 0) {
            openers.set(tab, byId.get(tab.openerTabId));
        }
    }
    return openers;
}

export function getOpeners(tabs) {
    return new Map([...getOpenersById(tabs), ...getOpenersByOffset(tabs)]);
}

export function withOffsets(tabs, openers = getOpeners(tabs), {removeIds = false} = {}) {
    return tabs.map((tab, index) => {
        const openerIndex = tabs.indexOf(openers.get(tab));
        tab = {...tab};
        delete tab.openerOffset;
        if (removeIds) {
            delete tab.id;
            delete tab.openerTabId;
        }
        if (openerIndex >= 0 && openerIndex !== index) {
            tab.openerOffset = openerIndex - index;
        }
        return tab;
    });
}

async function setOpeners(links) {
    const updated = new Map;
    if (links.length) {
        await Promise.all(links.map(async ([tabId, openerTabId]) => {
            try {
                const tab = browserTabToAddon(await browser.tabs.update(tabId, {openerTabId}));
                Cache.mirrorTab(tab);
                updated.set(tabId, tab);
            } catch (e) {}
        }));
    }
    return updated;
}

export async function applyOpeners(savedTabs, aligned) {
    const links = [];
    for (const [tab, opener] of getOpenersByOffset(savedTabs, aligned)) {
        if (opener && opener.id !== tab.id && opener.windowId === tab.windowId) {
            links.push([tab.id, opener.id]);
        }
    }
    await setOpeners(links);
}

async function queryLiveMembers(windowIds) {
    const members = [];
    for (const windowId of windowIds) {
        const tabs = await query({windowId, pinned: false, hidden: false}, {raw: true});
        members.push(...tabs.filter(tab => tab.groupId !== SubGroups.TAB_GROUP_ID_NONE));
    }
    return members;
}

export async function recreate(tabs, buildTabFunc) {
    const originals = await list(tabs, {sortByIndex: true});
    const windowIds = new Set(originals.map(tab => tab.windowId));
    const membersBefore = await queryLiveMembers(windowIds);
    const liveIdByOldId = new Map(membersBefore.map(tab => [tab.id, tab.groupId]));
    const firstMemberIds = new Set(
        [...Map.groupBy(membersBefore, tab => tab.groupId).values()]
            .filter(members => members.length > 1)
            .map(members => members.toSorted(Utils.sortBy('index'))[0].id)
    );

    const copyByOldId = new Map;
    const insertedByWindow = new Map;

    for (const tab of originals) {
        const inserted = insertedByWindow.get(tab.windowId) ?? 0;
        const index = tab.index + inserted + (firstMemberIds.has(tab.id) ? 1 : 0);
        try {
            const copy = await create({
                ...buildTabFunc(tab),
                index,
                windowId: tab.windowId,
                openerTabId: undefined,
            }, {allowDiscarded: !isSharing(tab)});
            copyByOldId.set(tab.id, copy);
            insertedByWindow.set(tab.windowId, inserted + 1);
        } catch (error) {}
    }

    const liveIdByCopyId = new Map((await queryLiveMembers(windowIds)).map(tab => [tab.id, tab.groupId]));
    const copiesByLiveId = new Map;

    for (const [oldId, copy] of copyByOldId) {
        const liveId = liveIdByOldId.get(oldId);
        if (liveId && liveIdByCopyId.get(copy.id) !== liveId) {
            copiesByLiveId.getOrInsert(liveId, []).push(copy);
        }
    }

    for (const [liveId, copies] of copiesByLiveId) {
        await group(copies, copies[0].windowId, {joinLiveGroupId: liveId});
    }

    const links = [];
    for (const tab of originals) {
        if (copyByOldId.has(tab.id) && tab.openerTabId > 0 && tab.openerTabId !== tab.id) {
            links.push([copyByOldId.get(tab.id).id, copyByOldId.get(tab.openerTabId)?.id ?? tab.openerTabId]);
        }
    }

    for (const child of Cache.getTabChildren(copyByOldId.keys())) {
        if (!copyByOldId.has(child.id)) {
            links.push([child.id, copyByOldId.get(child.openerTabId).id]);
        }
    }

    await setOpeners(links);

    const copiesToHide = originals
        .filter(tab => copyByOldId.has(tab.id) && (tab.hidden || (tab.groupId && !Cache.getWindowId(tab.groupId))))
        .map(tab => copyByOldId.get(tab.id));

    await hide(copiesToHide);
    await remove([...copyByOldId.keys()]);

    return tabs.map(tab => copyByOldId.get(extractId(tab)));
}

export async function createUrlOnce(url) {
    let [tab] = await query({
        url: url.includes('#') ? url.slice(0, url.indexOf('#')) : url,
        hidden: false,
        windowType: null,
    }, {withSession: false});

    if (tab) {
        const updateProperties = { active: true };
        if (tab.browserUrl !== url) updateProperties.url = url;
        [tab] = await tabsAction({action: 'update'}, tab, updateProperties);
    }

    tab ??= browserTabToAddon(await browser.tabs.create({ url, active: true }));
    return tab;
}

export async function setActive(tabId = null, tabs = []) {
    let tabToActive = null;
    if (tabId) {
        tabToActive = tabs.find(tab => tab.id === tabId) || { id: tabId };
    } else if (tabs.length) {
        const maxLastAccessed = Math.max(...tabs.map(tab => tab.lastAccessed));
        tabToActive = tabs.find(tab => tab.lastAccessed === maxLastAccessed);
    }

    if (tabToActive) {
        tabs.forEach(tab => tab.active = tab.id === tabToActive.id);
        await browser.tabs.update(tabToActive.id, { active: true }).catch(() => {});
    }
    return tabToActive;
}

export async function getActive(windowId) {
    const [activeTab] = await query({windowId, active: true});
    return activeTab;
}

export async function getNewTabIndex(tabs) {
    if (!tabs.length) return null;
    const hasBrowserSettingsPermission = await BrowserSettings.hasPermission();
    if (hasBrowserSettingsPermission) {
        const {newTabPosition: {value: newTabPosition}} = await BrowserSettings.get();
        if (newTabPosition === 'afterCurrent') {
            return tabs.toSorted(Utils.sortBy('lastAccessed')).at(-1).index + 1;
        }
    }
    return tabs.at(-1).index + 1;
}

export async function getHighlightedIds(windowId, clickedTab = null, pinned = false) {
    let tabs = await query({windowId, pinned, hidden: false, highlighted: true});
    if (clickedTab && !tabs.some(tab => tab.id === clickedTab.id)) {
        tabs.push(clickedTab);
        if (2 === tabs.length) {
            tabs = tabs.filter(tab => tab.active ? (tab.id === clickedTab.id) : true);
        }
    }
    return tabs.map(extractId);
}

export async function query(queryInfo = {}, params) {
    const queryParams = { windowType: browser.windows.WindowType.NORMAL, ...queryInfo };
    for (const key in queryParams) {
        if (queryParams[key] == null) delete queryParams[key];
    }
    return await prepare(await browser.tabs.query(queryParams), params);
}

async function prepare(tabs, params = {}) {
    const raw = params.raw ?? false;
    const withSession = params.withSession ?? true;
    tabs = tabs.filter(tab => !skip.removed.has(tab.id));
    if (raw) return tabs;
    tabs.forEach(browserTabToAddon);
    if (!withSession) return tabs;
    tabs = await Promise.all(tabs.map(tab => Cache.loadTabSession(tab, params)));
    tabs = tabs.filter(Boolean);
    tabs.forEach(fillEmptyUrl);
    return tabs;
}

export async function get(tab, params) {
    const [found] = await list([tab], params);
    return found;
}

export async function list(tabs, params = {}) {
    const sortByIndex = params.sortByIndex ?? false;
    const found = await Promise.all(tabs.map(tab => browser.tabs.get(extractId(tab)).catch(() => null)));
    tabs = await prepare(found.filter(Boolean), params);
    if (sortByIndex) {
        tabs = [...Map.groupBy(tabs, tab => tab.windowId).values()]
            .flatMap(windowTabs => windowTabs.toSorted(Utils.sortBy('index')));
    }
    return tabs;
}

export async function createTempActiveTab(windowId, createPinnedTab = true, newTabUrl) {
    const pinnedTabs = await query({windowId, pinned: true}, {withSession: false});
    if (pinnedTabs.length) {
        if (!pinnedTabs.some(tab => tab.active)) {
            await setActive(Utils.getLastActiveTab(pinnedTabs).id);
        }
    } else {
        return await create({
            url: createPinnedTab ? (newTabUrl || 'about:blank') : (newTabUrl || 'about:newtab'),
            pinned: createPinnedTab,
            active: true,
            index: 0,
            windowId,
            groupId: createPinnedTab ? undefined : Cache.getWindowGroup(windowId),
        });
    }
}

export function add(...args) {
    return Operations.run('add-tab', () => addNow(...args));
}

async function addNow(groupId, cookieStoreId, url, title) {
    const windowId = Cache.getWindowId(groupId);
    const {group} = await Groups.load(groupId, !windowId);
    const tab = await create({
        url,
        title,
        cookieStoreId,
        index: windowId ? null : await getNewTabIndex(group.tabs),
        windowId: windowId || group.tabs[0]?.windowId,
        ...Groups.getNewTabParams(group),
    });

    if (!windowId) {
        await Groups.hideTabs(group, [tab]);
    }
    return tab;
}

const THUMBNAIL_HEIGHT = 192;

export async function updateThumbnail(tabId) {
    if (!settings.showTabsWithThumbnailsInManageGroups) return;
    const tab = await get(tabId, {withSession: false});
    if (!tab || !isLoaded(tab)) return;
    if (tab.discarded) {
        reload(tab.id);
        return;
    }

    try {
        const zoom = await browser.tabs.getZoom(tab.id);
        let thumbnail = await browser.tabs.captureTab(tab.id, {
            format: browser.extensionTypes.ImageFormat.JPEG,
            quality: 70,
            scale: THUMBNAIL_HEIGHT / tab.height / zoom,
        });

        if (await Utils.isImageUniform(thumbnail)) thumbnail = null;
        await Cache.setTabThumbnail(tab.id, thumbnail);
        send('updated', { tabId: tab.id, changeInfo: {thumbnail} });
    } catch (e) {}
}

export function move(...args) {
    return Operations.run('move-tabs', () => moveNow(...args));
}

async function moveNow(tabIds, groupId, params = {}) {
    const auto = params.auto ?? false;
    const newTabIndex = params.newTabIndex ?? null;
    const groupWindowId = Cache.getWindowId(groupId);
    const {group, groups} = await Groups.load(groupId, !groupWindowId);

    if (!group) return [];

    const showTab = params.showTab ?? (auto && group.afterAutoMoveShowTab);
    const showOnlyActiveTab = params.showOnlyActiveTab ?? (auto && group.afterAutoMoveShowOnlyActiveTab);
    const showNotification = params.showNotification ?? (auto && group.afterAutoMoveShowNotification);

    let tabs = await list(tabIds, { sortByIndex: true, includeFavIconUrl: true, includeThumbnail: true });
    if (!tabs.length) return [];

    const skippedTabs = skipTrackingTabs(tabs.map(extractId));
    const windowId = groupWindowId || group.tabs[0]?.windowId || tabs[0].windowId;
    let showPinnedMessage = false;

    tabs = tabs.filter(tab => {
        if (tab.pinned) {
            showPinnedMessage = true;
            continueTrackingTabs([tab], skippedTabs);
            return false;
        }
        return true;
    });

    tabs.forEach(tab => updatedBatch.add(tab.id, updatedKey(tab.groupId, tab.windowId)));

    const activeTabs = [];
    let tempTabs = [];
    let destSubGroupId = null;
    let membershipSnapshot = null;

    try {
        if (!groupWindowId) {
            const tabsToHide = await Groups.pinSharingTabs(tabs);
            if (tabsToHide.length < tabs.length) {
                continueTrackingTabs(tabs.filter(tab => !tabsToHide.includes(tab)), skippedTabs);
                tabs = await list(tabsToHide, { sortByIndex: true, includeFavIconUrl: true, includeThumbnail: true });
            }
        }

        if (tabs.length) {
            destSubGroupId = resolveDestSubGroupId(group, groupWindowId, tabs, newTabIndex);
            tempTabs = await activateOutside(tabs.filter(tab => tab.windowId !== groupWindowId));
            membershipSnapshot = destSubGroupId ? null : await SubGroups.snapshotMembership(tabs, groups, groupId);
            tabs = await recreateTabsForContainer(tabs, group, activeTabs, membershipSnapshot, skippedTabs, logger);
        }

        if (tabs.length) {
            tabs = await moveNative(tabs, {
                index: newTabIndex ?? await resolveMoveIndex(groupId, windowId, tabs),
                windowId,
            });

            if (groupWindowId) {
                await Groups.showTabs(group, tabs);
            } else {
                await Groups.hideTabs(group, tabs);
            }

            await Promise.all(tabs.map(tab => Cache.setTabGroup(tab.id, groupId)));
            tabs.forEach(tab => updatedBatch.add(tab.id, groupId));

            if (destSubGroupId) {
                await Promise.allSettled(tabs.map(tab => {
                    tab.subGroupId = destSubGroupId;
                    return Cache.setTabSubGroupId(tab.id, destSubGroupId);
                }));
            } else {
                await SubGroups.restoreMembership(group, tabs, membershipSnapshot);
            }
        }
    } finally {
        continueTrackingTabs(skippedTabs);
    }

    if (showPinnedMessage) Notification('pinnedTabsAreNotSupported');
    if (!tabs.length) return [];

    return applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, tempTabs, {showTab, showOnlyActiveTab, showNotification}, logger);
}

export async function moveToWindow(tabs, groupId, windowId) {
    const anchorTab = tabs.find(tab => tab.windowId === windowId);
    return moveNative(tabs, {
        index: anchorTab?.index ?? await resolveMoveIndex(groupId, windowId, tabs),
        windowId,
    });
}

async function resolveMoveIndex(groupId, windowId, movingTabs) {
    const movingIds = new Set(movingTabs.map(extractId));
    const groupTabs = (await query({windowId, pinned: false})).filter(tab => !movingIds.has(tab.id) && tab.groupId === groupId);
    const anchor = await getNewTabIndex(groupTabs);

    if (anchor != null) return anchor;

    if (movingTabs.every(tab => tab.windowId === windowId)) {
        if (!await SubGroups.hasLiveGroups(windowId)) return movingTabs[0].index;
        await ungroup(movingTabs);
        return (await get(movingTabs[0], {withSession: false}))?.index ?? movingTabs[0].index;
    }

    return (await browser.tabs.query({windowId})).length;
}

function resolveDestSubGroupId(group, groupWindowId, tabs, newTabIndex) {
    if (groupWindowId || newTabIndex == null) return;
    const movingTabIds = new Set(tabs.map(extractId));
    const targetTab = group.tabs.find(tab => !movingTabIds.has(tab.id) && tab.index === newTabIndex);
    if (group.subGroups.some(subGroup => subGroup.id === targetTab?.subGroupId)) {
        return targetTab.subGroupId;
    }
}

async function recreateTabsForContainer(tabs, group, activeTabs, membershipSnapshot, skippedTabs, log) {
    const containerParams = Groups.getContainerParams(group);
    const containerOf = new Map(tabs.map(tab => [tab.id, getNewTabContainer(tab, containerParams)]));
    const tabsToRecreate = tabs.filter(tab => tab.cookieStoreId !== containerOf.get(tab.id));

    if (!tabsToRecreate.length) {
        activeTabs.push(...tabs.filter(tab => tab.active));
        return tabs;
    }

    const newTabs = await recreate(tabsToRecreate, tab => ({
        ...tab,
        cookieStoreId: containerOf.get(tab.id),
        groupId: undefined,
        subGroupId: undefined,
        active: false,
    }));

    skipTrackingTabs(newTabs.filter(Boolean), skippedTabs);
    const newTabByOldId = new Map(tabsToRecreate.map((tab, index) => [tab.id, newTabs[index]]));

    return tabs.flatMap(tab => {
        if (!newTabByOldId.has(tab.id)) {
            if (tab.active) activeTabs.push(tab);
            return [tab];
        }

        const newTab = newTabByOldId.get(tab.id);
        if (!newTab) {
            continueTrackingTabs([tab], skippedTabs);
            return [];
        }

        if (membershipSnapshot?.has(tab.id)) {
            membershipSnapshot.set(newTab.id, membershipSnapshot.get(tab.id));
            membershipSnapshot.delete(tab.id);
        }

        if (tab.active) activeTabs.push({...newTab, active: true});
        return [newTab];
    });
}

async function applyGroupAndNotify(group, groupId, windowId, tabs, activeTabs, tempTabs, {showTab, showOnlyActiveTab, showNotification}, log) {
    let [firstTab] = activeTabs.length ? activeTabs : tabs;
    const applyGroup = showTab && (!showOnlyActiveTab || activeTabs.length > 0);

    if (applyGroup) {
        if (await Groups.apply(windowId, groupId, firstTab.id)) {
            await remove(tempTabs.filter(tab => tab.windowId === windowId), {ungroupNative: false, keepWindowsAlive: false});
        }
    }

    if (applyGroup || !showNotification) return tabs;

    let message = tabs.length > 1 ? ['moveMultipleTabsToGroupMessage', tabs.length] : ['moveTabToGroupMessage', group.title, getTitle(firstTab, false, 50)];
    let iconUrl = tabs.length > 1 ? Groups.getIconUrl(group) : normalizeFavIcon(firstTab).favIconUrl;

    Notification(message, {
        iconUrl,
        module: ['groups', 'apply', null, groupId, firstTab.id],
    });

    return tabs;
}

export async function moveNative(tabs, moveProperties = {}, params = {}) {
    tabs = Array.isArray(tabs) ? tabs : [tabs];
    tabs = await list(tabs, {includeFavIconUrl: true, includeThumbnail: true});
    const tabsBeforeMoveMap = new Map(tabs.map(tab => [tab.id, tab]));

    tabs = await tabsAction({action: 'move', ...params}, tabs, moveProperties);
    const links = [];

    for (const tab of tabs) {
        const beforeMove = tabsBeforeMoveMap.get(tab.id);
        if (beforeMove?.windowId !== tab.windowId && beforeMove?.openerTabId > 0 && beforeMove.openerTabId !== tab.id) {
            links.push([tab.id, beforeMove.openerTabId]);
        }
    }

    const updated = await setOpeners(links);
    tabs = tabs.map(tab => updated.get(tab.id) ?? tab);
    tabs.forEach(tab => Cache.KEYS.forEach(key => delete tab[key]));

    const mirrorWindowIds = new Set();
    for (const tab of tabsBeforeMoveMap.values()) mirrorWindowIds.add(tab.windowId);
    for (const tab of tabs) mirrorWindowIds.add(tab.windowId);
    mirrorWindowIds.forEach(id => SubGroups.scheduleMirrorWindow(id));

    return tabs;
}

const tabsActionSchema = new Map([
    ['create', {skipTrackingCreated: true}],
    ['get', {sendOneByOne: true, returnsTabs: true}],
    ['discard', {sendArray: true, sendOneByOne: true}],
    ['show', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['hide', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['remove', {sendArray: true, sendOneByOne: true, skipTracking: true}],
    ['update', {sendOneByOne: true, returnsTabs: true}],
    ['reload', {sendOneByOne: true}],
    ['move', {sendArray: true, returnsTabs: true, skipTracking: true}],
    ['group', {sendAsIs: true, skipTracking: true, defaultValue: browser.tabGroups.TAB_GROUP_ID_NONE}],
    ['ungroup', {sendArray: true, sendOneByOne: true, skipTracking: true}],
]);

async function tabsAction({action, ...params}, tabs, ...funcArgs) {
    const schema = tabsActionSchema.get(action);
    if (!schema) throw new Error(`invalid action: ${action}`);
    if (action === 'create') throw new Error('create is not sent by tabsAction');

    const skipTracking = params.skipTracking ?? schema.skipTracking ?? false;
    if (!tabs) throw new Error(`invalid tabs`);

    tabs = Array.isArray(tabs) ? tabs : [tabs];
    let result = schema.defaultValue ?? [];
    const tabIds = tabs.map(extractId);

    if (!tabs.length) return result;
    if (action === 'remove' && skipTracking) {
        tabIds.forEach(tabId => skip.removed.add(tabId));
    }

    const skipped = skipTracking ? new Set(tabIds).difference(skip.tracking) : new Set;
    skipTrackingTabs(skipped);

    async function sendOneByOne() {
        const settled = await Promise.allSettled(tabIds.map(tabId => browser.tabs[action](tabId, ...funcArgs)));
        for (const [index, {status, value}] of settled.entries()) {
            if (status === 'fulfilled') result.push(value || tabIds[index]);
        }
    }

    try {
        if (schema.sendAsIs) {
            result = await browser.tabs[action](...funcArgs);
            return result;
        }

        if (schema.sendArray) {
            try {
                result = await browser.tabs[action](tabIds, ...funcArgs);
                result ||= tabIds;
            } catch (e) {
                if (schema.sendOneByOne) await sendOneByOne();
                else throw e;
            }
        } else if (schema.sendOneByOne) {
            await sendOneByOne();
        }
    } finally {
        continueTrackingTabs(skipped);
    }

    if (schema.returnsTabs) result.forEach(browserTabToAddon);
    return result;
}

export async function show(tabs, params = {}) {
    return await tabsAction({action: 'show', ...params}, tabs);
}

async function activateOutside(tabs) {
    const ids = new Set(tabs.map(extractId));
    const tempTabs = [];
    if (!ids.size) return tempTabs;

    const activeTabs = await query({active: true}, {withSession: false});
    for (const activeTab of activeTabs.filter(tab => ids.has(tab.id))) {
        const visibleTabs = await query({windowId: activeTab.windowId, hidden: false}, {withSession: false});
        const otherTabs = visibleTabs.filter(tab => !ids.has(tab.id));
        if (otherTabs.length) await setActive(null, otherTabs);
        else tempTabs.push(await createTempActiveTab(activeTab.windowId, false));
    }
    return tempTabs.filter(Boolean);
}

export async function hide(tabs, params = {}) {
    const activateOther = params.activateOther ?? false;
    const ungroupNative = params.ungroupNative ?? true;
    tabs = Array.isArray(tabs) ? tabs : [tabs];
    if (!tabs.length) return [];

    if (activateOther) await activateOutside(tabs);
    if (ungroupNative) await ungroup(tabs);
    return await tabsAction({action: 'hide', ...params}, tabs);
}

export async function discard(tabs, params = {}) {
    tabs = [tabs].flat().filter(tabOrId => !Utils.isUrlEmpty(tabOrId.browserUrl));
    return await tabsAction({action: 'discard', ...params}, tabs);
}

export async function pin(tabs) {
    return await tabsAction({action: 'update', skipTracking: true}, tabs, {pinned: true});
}

export async function group(tabs, windowId, params = {}) {
    const joinLiveGroupId = params.joinLiveGroupId ?? null;
    const tabIds = tabs.map(extractId);
    const groupProperties = joinLiveGroupId ? {tabIds, groupId: joinLiveGroupId} : {tabIds, createProperties: {windowId}};
    return await tabsAction({action: 'group', ...params}, tabs, groupProperties);
}

export async function ungroup(tabs, params = {}) {
    return await tabsAction({action: 'ungroup', ...params}, tabs);
}

export async function reload(tabs, bypassCache = false) {
    return await tabsAction({action: 'reload'}, tabs, {bypassCache});
}

export async function setMute(tabs, muted, params = {}) {
    const onlyMutedBySelf = params.onlyMutedBySelf ?? false;
    muted = Boolean(muted);
    if (onlyMutedBySelf) tabs = tabs.filter(tab => !tab.mutedInfo || isMutedBySelf(tab));

    const ids = new Set(tabs.map(extractId));
    if (!ids.size) return [];

    const found = await query(muted ? {audible: true} : {muted: true}, {withSession: false});
    const tabsToUpdate = found.filter(tab => ids.has(tab.id) && (!onlyMutedBySelf || isMutedBySelf(tab)));
    return await tabsAction({action: 'update'}, tabsToUpdate, {muted});
}

async function ensureWindowsAlive(tabsToRemove) {
    const removedIds = new Set(tabsToRemove.map(extractId));
    const visibleTabs = await query({hidden: false}, {withSession: false});
    for (const [windowId, windowTabs] of Map.groupBy(visibleTabs, tab => tab.windowId)) {
        if (windowTabs.every(tab => removedIds.has(tab.id))) {
            await createTempActiveTab(windowId, false).catch(() => {});
        }
    }
}

export async function remove(tabs, params = {}) {
    const ungroupNative = params.ungroupNative ?? true;
    const keepWindowsAlive = params.keepWindowsAlive ?? true;
    tabs = Array.isArray(tabs) ? tabs : [tabs];
    if (!tabs.length) return [];

    if (ungroupNative) await ungroup(tabs);
    if (keepWindowsAlive) await ensureWindowsAlive(tabs);
    return await tabsAction({action: 'remove', ...params}, tabs);
}

export async function sendMessage(tabId, message) {
    message = {colorScheme: settings.colorScheme, ...message};
    return browser.tabs.sendMessage(tabId, message).catch(() => {});
}

export function prepareForSave(tabs, params = {}) {
    if (params.includeOpener !== false) tabs = withOffsets(tabs);
    return tabs.map(tab => prepareForSaveTab(tab, params));
}

export function prepareForSaveTab(sourceTab, {includeGroupId = false, includeSubGroupId = true, includeFavIconUrl = false, includeThumbnail = false, includeOpener = true, includeLastAccessed = true} = {}) {
    const {url, title, cookieStoreId, favIconUrl, openerOffset, groupId, subGroupId, thumbnail, lastAccessed} = sourceTab;
    const tab = {url};

    if (title) tab.title = title;
    if (!Containers.isDefault(cookieStoreId)) {
        tab.cookieStoreId = Containers.isTemporary(cookieStoreId) ? Constants.TEMPORARY_CONTAINER : cookieStoreId;
    }
    if (includeGroupId && groupId) tab.groupId = groupId;
    if (includeSubGroupId && subGroupId) tab.subGroupId = subGroupId;
    if (includeFavIconUrl && favIconUrl?.startsWith('data:')) tab.favIconUrl = favIconUrl;
    if (includeThumbnail && thumbnail) tab.thumbnail = thumbnail;
    if (includeLastAccessed && lastAccessed) tab.lastAccessed = lastAccessed;
    if (includeOpener && openerOffset) tab.openerOffset = openerOffset;

    return tab;
}

export function getNewTabContainer({cookieStoreId}, {newTabContainer = Constants.DEFAULT_COOKIE_STORE_ID, ifDifferentContainerReOpen, excludeContainersForReOpen = []}) {
    if (cookieStoreId === newTabContainer || Containers.isTemporary(cookieStoreId)) return cookieStoreId;
    if (ifDifferentContainerReOpen) return excludeContainersForReOpen.includes(cookieStoreId) ? cookieStoreId : newTabContainer;
    return Containers.isDefault(cookieStoreId) ? newTabContainer : cookieStoreId;
}

export function getPageUrl(url) {
    return url?.startsWith(Constants.READER_MODE_PAGE) ? Utils.getNestedUrl(url) ?? url : url;
}

export function urlToAddon(url) {
    return Extensions.urlToId(unwrapUrl(url));
}

export function tabUrlToAddon(tab) {
    tab.url = urlToAddon(tab.url);
    return tab;
}

function browserTabToAddon(tab) {
    SubGroups.detachTabGroupId(tab);
    Object.defineProperty(tab, 'browserUrl', {value: tab.url, writable: true, configurable: true});
    tabUrlToAddon(tab);
    return tab;
}

export function getTitle({id, index, title, url, discarded, windowId, lastAccessed}, withUrl = false, sliceLength = 0, withActiveTab = false) {
    url = Utils.sliceText(getPageUrl(url), 2048);
    title = title || url || 'about:blank';

    if (withUrl && url && title !== url) title += '\n' + url;
    if (withActiveTab && id) title = (discarded ? Constants.DISCARDED_SYMBOL : Constants.ACTIVE_SYMBOL) + ' ' + title;

    return sliceLength ? Utils.sliceText(title, sliceLength) : title;
}

const restrictedDomains = new Set('accounts-static.cdn.mozilla.net,accounts.firefox.com,addons.cdn.mozilla.net,addons.mozilla.org,api.accounts.firefox.com,content.cdn.mozilla.net,discovery.addons.mozilla.org,oauth.accounts.firefox.com,profile.accounts.firefox.com,support.mozilla.org,sync.services.mozilla.com'.split(','));

export function isCanSendMessage({browserUrl: url}) {
    if (url === 'about:blank') return true;
    if (url.startsWith('about:')) return false;
    if (Extensions.isExtensionUrl(url) && !Extensions.isOwnUrl(url)) return false;
    const urlObj = URL.parse(url);
    return !!urlObj && !restrictedDomains.has(urlObj.hostname);
}

export function extractId(tab) {
    return tab.id || tab;
}

export function isPinned(tab) {
    return tab.pinned === true;
}

export function isSharing(tab) {
    return Boolean(tab.sharingState?.screen || tab.sharingState?.camera || tab.sharingState?.microphone);
}

function isMutedBySelf(tab) {
    return Boolean(tab.mutedInfo?.muted) && tab.mutedInfo.extensionId === browser.runtime.id;
}

export function isLoaded(tab) {
    return tab.status === browser.tabs.TabStatus.COMPLETE;
}

export function isLoading(tab) {
    return tab.status === browser.tabs.TabStatus.LOADING;
}

export function fillEmptyUrl(tab) {
    if (Utils.isUrlEmpty(tab.url)) {
        tab.url = Cache.getTabUrl(tab.id) ?? tab.url;
    }
    return tab;
}

export function normalizeFavIcon(tab) {
    if (!Utils.isAvailableFavIconUrl(tab.favIconUrl)) {
        tab.favIconUrl = ConstantsBrowser.DEFAULT_FAVICON;
    }
    return tab;
}

export function isSame(tab1, tab2, keys = ['url', 'cookieStoreId', 'groupId']) {
    return Utils.isEqualByKeys(tab1, tab2, keys);
}

export async function restoreOldExtensionUrls(parseUrlFunc = null) {
    let tabs = await query({
        url: Constants.PAGES.HELP_PATHS.map(path => `moz-extension://*/${path}*`),
        windowType: null,
    }, {withSession: false});

    tabs = tabs.filter(tab => Extensions.isOwnUrl(tab.browserUrl) || !Extensions.getByUrl(tab.browserUrl));

    await Promise.allSettled(tabs.map(async tab => {
        const url = parseUrlFunc ? await parseUrlFunc(tab) : tab.browserUrl;
        if (!url.startsWith(Constants.STG_BASE_URL) || url !== tab.browserUrl) {
            await browser.tabs.update(tab.id, {
                url: Constants.STG_BASE_URL + url.slice(Constants.STG_BASE_URL.length),
                loadReplace: true,
            });
        }
    }));
}

export async function reconcile(groups, allTabs) {
    allTabs = allTabs.slice();
    const containersStorageMap = new Map;
    const sameTabKeys = ['url', 'cookieStoreId'];

    for (const group of groups) {
        if (group.isArchive) continue;

        const newTabParams = Groups.getNewTabParams(group);
        const groupWindowId = Cache.getWindowId(group.id) || group.tabs[0]?.windowId;
        const sessionPromises = [];
        const savedTabs = group.tabs;
        const tabs = [];

        for (const tab of savedTabs) {
            tab.groupId = group.id;
            tab.cookieStoreId = await Containers.findExistOrCreateSimilar(tab.cookieStoreId, null, containersStorageMap);

            const winTabIndex = allTabs.findIndex(winTab => isSame(winTab, tab, sameTabKeys));
            if (winTabIndex !== -1) {
                const [winTab] = allTabs.splice(winTabIndex, 1);
                delete winTab.subGroupId;
                sessionPromises.push(Cache.setTabSession(winTab, tab));
                tabs.push(winTab);
            } else {
                tabs.push({
                    ...tab,
                    new: true,
                    windowId: groupWindowId,
                    active: null,
                    index: null,
                    ...newTabParams,
                });
            }
        }

        await Promise.allSettled(sessionPromises);
        const {live, aligned} = await createMultiple(tabs, {createMissing: true, hideUnloaded: false});
        group.tabs = await ensureSorted(live);
        await applyOpeners(savedTabs, aligned);
    }
    return groups;
}

export async function ensureSorted(tabs, params = {}) {
    const byMinIndex = params.byMinIndex ?? false;
    let liveTabs = await list(tabs, {withSession: false});

    const isBlock = liveTabs.every((tab, i) => {
        if (i === 0) return true;
        const prevTab = liveTabs[i - 1];
        if (tab.windowId !== prevTab.windowId) return false;
        return tab.index === prevTab.index + 1;
    });

    const startIndex = byMinIndex ? Math.min(...liveTabs.map(tab => tab.index)) : liveTabs[0]?.index;

    if (!isBlock && Number.isInteger(startIndex)) {
        liveTabs = await moveNative(liveTabs, {index: startIndex}, params);
    }

    return liveTabs;
}
