import './prefixed-storage.js';

import Logger, {errorEventHandler} from './logger.js';
import Queue from './queue.js';
import backgroundSelf from './background.js';
import * as GroupsBroadcast from './broadcast.js?channel=groups';
import * as Constants from './constants.js';
import * as Storage from './storage.js';
import * as Cache from './cache.js';
import Notification from './notification.js';
import Lang from '/js/lang.js';
import * as Containers from './containers.js';
import * as Browser from './browser.js';
import * as Bookmarks from './bookmarks.js';
import * as Extensions from './extensions.js';
import * as Menus from './menus.js';
import * as MenusMain from './menus-main.js';
import * as Tabs from './tabs.js';
import * as SubGroups from './sub-groups.js';
import * as Operations from './operations.js';
import * as Windows from './windows.js';
import * as Utils from './utils.js';
import * as NewCloudGroups from './sync/new-cloud-groups.js';
import GroupsHistory from './groups-history.js';

export {on, off} from './broadcast.js?channel=groups';

const logger = new Logger(Constants.MODULES.GROUPS);
const mainStorage = localStorage.create(Constants.MODULES.BACKGROUND);
const windowsWithLoadingGroups = new Set();
const groupsHistory = new GroupsHistory();

export function fillHistory(windows) {
    return groupsHistory.fill(windows);
}

export async function applyByPosition(direction, windowId, groups, currentGroupId) {
    if (!groups.length) return false;

    const currentGroupIndex = groups.findIndex(group => group.id === currentGroupId);
    const nextGroupIndex = Utils.getNextIndex(currentGroupIndex, groups.length, direction, true);

    return apply(windowId, groups[nextGroupIndex].id);
}

export async function applyByHistory(direction, windowId, groups) {
    const nextGroupId = await groupsHistory.move(windowId, groups, direction);
    if (!nextGroupId) return false;
    return apply(windowId, nextGroupId, undefined, true);
}

export function apply(...args) {
    return Operations.run('apply-group', () => applyNow(...args));
}

async function applyNow(windowId, groupId, activeTabId, applyFromHistory = false) {
    const log = logger.start(apply, 'groupId:', groupId, 'windowId:', windowId, 'activeTabId:', activeTabId);

    windowId ??= (await Windows.getFocusedNormalWindow())?.id;

    if (!windowId) {
        log.stopError('no window was found for apply');
        return false;
    } else if (windowsWithLoadingGroups.has(windowId)) {
        log.stopWarn('window in loading state now', windowId);
        return false;
    }

    windowsWithLoadingGroups.add(windowId);
    const groupWindowId = Cache.getWindowId(groupId);
    let result = null;

    try {
        const addTabs = [];

        if (groupWindowId) {
            if (activeTabId) Tabs.setActive(activeTabId);
            Windows.setFocus(groupWindowId);
        } else {
            const {group: groupToShow, groupsById} = await load(groupId, true);
            const groupToHide = groupsById.get(Cache.getWindowGroup(windowId));
            const tabsIdsToRemove = new Set;

            if (!groupToShow) log.throwError('groupToShow not found');

            if (groupToShow.isArchive) {
                Notification(['groupIsArchived', groupToShow.title]);
                throw '';
            }

            await Browser.actionLoading();

            if (groupToShow.tabs.length) {
                if (groupToShow.tabs.some(tab => tab.windowId !== windowId)) {
                    groupToShow.tabs = await Tabs.moveToWindow(groupToShow.tabs, groupToShow.id, windowId);
                }

                await showTabs(groupToShow, groupToShow.tabs);
                groupToShow.tabs.forEach(tab => tab.hidden = false);
                await SubGroups.apply(windowId, groupToShow);
            }

            await Cache.setWindowGroup(windowId, groupToShow.id);

            if (groupToHide) {
                groupToHide.tabs = await hideTabs(groupToHide, groupToHide.tabs);
            }

            const activeTabGroupToHide = groupToHide?.tabs.find(tab => tab.active);

            async function hideUnSyncTabs(tabs) {
                if (!tabs.length) return;
                await hideTabs(null, tabs);
                await SubGroups.clearMembership(tabs);

                let showNotif = mainStorage.showTabsInThisWindowWereHidden ?? 0;
                if (showNotif < 5) {
                    mainStorage.showTabsInThisWindowWereHidden = ++showNotif;
                    Notification('tabsInThisWindowWereHidden');
                }
            }

            if (activeTabId) {
                await Tabs.setActive(activeTabId);
                if (!groupToHide) {
                    let tabs = await Tabs.query({windowId, pinned: false, hidden: false});
                    tabs = tabs.filter(tab => !tab.groupId);
                    if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                        tabsIdsToRemove.add(tabs[0].id);
                    } else {
                        await hideUnSyncTabs(tabs);
                    }
                }
            } else if (groupToHide) {
                if (activeTabGroupToHide) {
                    const tabToActive = await Tabs.setActive(null, groupToShow.tabs);
                    if (!tabToActive) {
                        const pinnedTabs = await Tabs.query({windowId, pinned: true, hidden: false}, {withSession: false}),
                            activePinnedTab = await Tabs.setActive(null, pinnedTabs);

                        if (!activePinnedTab) {
                            await Tabs.create({ active: true, windowId, ...getNewTabParams(groupToShow) });
                        }
                    }
                }
            } else {
                let tabs = await Tabs.query({windowId, hidden: false});
                tabs = tabs.filter(tab => !tab.groupId);
                const activePinnedTab = await Tabs.setActive(null, tabs.filter(tab => tab.pinned));
                tabs = tabs.filter(tab => !tab.pinned);

                if (activePinnedTab) {
                    await hideUnSyncTabs(tabs);
                } else {
                    if (groupToShow.tabs.length) {
                        await Tabs.setActive(null, groupToShow.tabs);
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            tabsIdsToRemove.add(tabs[0].id);
                        } else {
                            await hideUnSyncTabs(tabs);
                        }
                    } else {
                        if (tabs.length === 1 && Utils.isUrlEmpty(tabs[0].url)) {
                            await Cache.setTabGroup(tabs[0].id, groupToShow.id).catch(log.onCatch(["can't set group", groupToShow.id, tabs[0]], false));
                            addTabs.push(Cache.applyTabSession(tabs[0]));
                        } else {
                            await Tabs.create({ active: true, windowId, ...getNewTabParams(groupToShow) });
                            await hideUnSyncTabs(tabs);
                        }
                    }
                }
            }

            if (groupToHide) {
                if (activeTabGroupToHide) await hideTabs(groupToHide, [activeTabGroupToHide]);
                groupToHide.tabs.forEach(tab => tab.url.startsWith(Extensions.urlToId(Constants.PAGES.MANAGE)) && tabsIdsToRemove.add(tab.id));
            }

            await Tabs.remove(Array.from(tabsIdsToRemove));
            await MenusMain.groupLoaded(groupToShow, windowId);
            if (groupToHide) await MenusMain.updateGroup(groupToHide);
            await Browser.actionLoading(false);

            if (!applyFromHistory) await groupsHistory.add(windowId, groupId);
        }

        sendLoaded(groupId, windowId, addTabs);
        result = true;
    } catch (e) {
        result = false;
        if (e) {
            errorEventHandler.call(log, e);
            await Browser.actionGroup(null, windowId);
        }
    } finally {
        windowsWithLoadingGroups.delete(windowId);
    }

    result ? log.stop() : log.stopError();
    return result;
}

const KEYS_RESPONSIBLE_VIEW = new Set([
    'title', 'iconUrl', 'iconColor', 'iconViewType', 'isArchive', 'isSticky', 'newTabContainer', 'prependTitleToWindow',
]);

function send(action, data = {}) {
    GroupsBroadcast.send({action, ...data});
}

export function sendAdded(group, windowId) { send('added', {group, windowId}); }
export function sendUpdated(group, fullGroup) { send('updated', {group, fullGroup}); }
export function sendRemoved(groupId, windowId) { send('removed', {groupId, windowId}); }
export function sendLoaded(groupId, windowId, addTabs = []) { send('loaded', {groupId, windowId, addTabs}); }
export function sendUnloaded(groupId, windowId) { send('unloaded', {groupId, windowId}); }
export function sendUpdatedAll() { send('updated.all'); }

if (Constants.IS_BACKGROUND_PAGE) {
    Containers.onChanged(async () => {
        if (!mainStorage.inited) return;
        const log = logger.start('Containers.onChanged listener');
        await writeQueue.run('containers-changed', async () => {
            const {groups} = await load();
            if (normalizeContainersInGroups(groups)) {
                await saveNow(groups);
            }
        });
        log.stop();
    });
}

export async function load(groupId = null, withTabs = false, params) {
    const log = logger.start('load', groupId, {withTabs, params});

    const [allTabs, {groups}] = await Promise.all([
        withTabs ? Tabs.query({pinned: false}, params) : false,
        Storage.get('groups')
    ]);

    if (withTabs) {
        const groupTabs = new Map(groups.map(group => [group.id, []]));

        await Promise.all(allTabs.map(async tab => {
            if (tab.groupId) {
                if (groupTabs.has(tab.groupId)) {
                    groupTabs.get(tab.groupId).push(tab);
                } else {
                    delete tab.groupId;
                    await Cache.removeTabGroup(tab.id);
                }
            }
        }));

        for (const group of groups) {
            if (!group.isArchive) {
                group.tabs = groupTabs.get(group.id).toSorted(Utils.sortBy('index'));
            }
        }
    }

    log.stop();

    const groupIndex = groups.findIndex(group => group.id === groupId);

    return {
        group: groups[groupIndex],
        groups,
        groupsById: new Map(groups.map(group => [group.id, group])),
        groupIndex,
        archivedGroups: groups.filter(group => group.isArchive),
        notArchivedGroups: groups.filter(group => !group.isArchive),
    };
}

const writeQueue = new Queue('Groups');

export function save(groups, withMessage = false) {
    return writeQueue.run('save', async () => {
        if (typeof groups === 'function') {
            groups = await groups();
            if (!groups) return groups;
        }
        return saveNow(groups, withMessage);
    });
}

async function saveNow(groups, withMessage = false) {
    const log = logger.start('save', {withMessage});
    if (!Array.isArray(groups)) log.throwError('groups has invalid type');

    await Storage.set({groups});

    if (isNeedBlockBeforeRequest(groups)) {
        backgroundSelf.addListenerOnBeforeRequest();
    } else {
        backgroundSelf.removeListenerOnBeforeRequest();
    }

    if (withMessage) sendUpdatedAll();
    log.stop();
    return groups;
}

export function createId() {
    return self.crypto.randomUUID();
}

export function create(id, title, defaultGroupProps = {}) {
    const group = {
        id,
        title: null,
        iconColor: null,
        iconUrl: null,
        iconViewType: Constants.DEFAULT_GROUP_ICON_VIEW_TYPE,
        tabs: [],
        isArchive: false,
        discardTabsAfterHide: false,
        discardExcludeAudioTabs: false,
        prependTitleToWindow: false,
        uploadToCloud: true,
        exportToBookmarks: true,
        newTabContainer: Constants.DEFAULT_COOKIE_STORE_ID,
        ifDifferentContainerReOpen: false,
        excludeContainersForReOpen: [],
        isSticky: false,
        catchTabContainers: [],
        catchTabRules: '',
        moveToGroupIfNoneCatchTabRules: null,
        muteTabsWhenGroupCloseAndRestoreWhenOpen: false,
        afterAutoMoveShowTab: false,
        afterAutoMoveShowOnlyActiveTab: false,
        afterAutoMoveShowNotification: true,
        subGroups: [],
        ...defaultGroupProps,
    };

    if (id) {
        group.title = createTitle(title, id, defaultGroupProps);
    } else {
        group.title ??= createTitle(title, null, defaultGroupProps);
    }

    group.iconColor ??= Utils.randomColor();
    return group;
}

export async function getDefaults() {
    const {defaultGroupProps} = await Storage.get('defaultGroupProps');
    const defaultGroup = create(undefined, undefined, defaultGroupProps);
    const defaultCleanGroup = create(undefined, undefined, {});

    delete defaultGroup.id;
    delete defaultGroup.tabs;
    delete defaultCleanGroup.id;
    delete defaultCleanGroup.tabs;

    defaultGroup.iconColor = defaultGroupProps.iconColor || '';
    defaultCleanGroup.iconColor = '';

    return { defaultGroup, defaultCleanGroup, defaultGroupProps };
}

export async function saveDefault(defaultGroupProps) {
    const log = logger.start('saveDefault', defaultGroupProps);
    await Storage.set({defaultGroupProps});
    log.stop();
}

export function add(...args) {
    return Operations.run('add-group', () => addNow(...args));
}

async function addNow(windowId, tabIds = [], title = null) {
    tabIds = tabIds?.slice?.() || [];
    title = title?.slice(0, 256);

    const log = logger.start(addNow, {windowId, tabIds, title});
    const windowGroupId = Cache.getWindowGroup(windowId);

    if (windowGroupId) {
        const result = await unload(windowGroupId);
        if (!result) return;
    }

    const newGroup = await writeQueue.run('add', async () => {
        const {groups} = await load();
        const {defaultGroupProps} = await getDefaults();
        const newGroup = create(createId(), title, defaultGroupProps);

        groups.push(newGroup);
        newGroup.title = Utils.format(newGroup.title, {index: groups.length});
        NewCloudGroups.add(newGroup.id);
        await saveNow(groups);
        return newGroup;
    });

    if (windowId) {
        await Cache.setWindowGroup(windowId, newGroup.id);
        await Browser.actionGroup(newGroup, windowId);
    }

    if (windowId && !tabIds.length) {
        tabIds = await Tabs.query({windowId, pinned: false, hidden: false}).then(tabs => tabs.map(Tabs.extractId));
    }

    if (tabIds.length) {
        newGroup.tabs = await Tabs.move(tabIds, newGroup.id);
    }

    sendAdded(newGroup, windowId);
    await MenusMain.groupAdded(newGroup, windowId);
    log.stop(newGroup.id);
    return newGroup;
}

export function remove(...args) {
    return Operations.run('remove-group', () => removeNow(...args));
}

async function removeNow(groupIds) {
    const log = logger.start(removeNow, groupIds);
    const idsToRemove = Utils.toSet(groupIds);
    const windowIdByGroupId = new Map;

    for (const groupId of idsToRemove) {
        const windowId = Cache.getWindowId(groupId);
        if (!windowId) continue;
        if (await unload(groupId)) {
            windowIdByGroupId.set(groupId, windowId);
        } else {
            idsToRemove.delete(groupId);
        }
    }

    const removedGroups = await writeQueue.run('remove', async () => {
        const {groups} = await load(null, true);
        const {defaultGroupProps} = await getDefaults();
        const groupsToRemove = groups.filter(group => idsToRemove.has(group.id));

        if (!groupsToRemove.length) return groupsToRemove;

        const restGroups = groups.filter(group => !idsToRemove.has(group.id));
        await Tabs.remove(groupsToRemove.flatMap(group => group.isArchive ? [] : group.tabs), {ungroupNative: false, keepWindowsAlive: false});

        let defaultGroupPropsChanged = false;
        for (const group of groupsToRemove) {
            group.index = groups.indexOf(group);
            if (removeRefs(group, restGroups, defaultGroupProps)) {
                defaultGroupPropsChanged = true;
            }
        }

        await saveNow(restGroups);
        if (defaultGroupPropsChanged) await saveDefault(defaultGroupProps);
        return groupsToRemove;
    });

    if (!removedGroups.length) return;

    for (const group of removedGroups) {
        await removeFinish(group);
        sendRemoved(group.id, windowIdByGroupId.get(group.id));
    }
    log.stop();
}

function removeRefs(group, groups, defaultGroupProps) {
    const log = logger.start(removeRefs, group.id);
    for (const gr of groups) {
        if (gr.moveToGroupIfNoneCatchTabRules === group.id) {
            gr.moveToGroupIfNoneCatchTabRules = null;
        }
    }
    let defaultGroupPropsChanged = false;
    if (defaultGroupProps.moveToGroupIfNoneCatchTabRules === group.id) {
        delete defaultGroupProps.moveToGroupIfNoneCatchTabRules;
        defaultGroupPropsChanged = true;
    }
    log.stop();
    return defaultGroupPropsChanged;
}

async function removeFinish(group) {
    NewCloudGroups.remove(group.id);
    await MenusMain.groupRemoved(group).catch(() => {});
    await addUndoRemove(group);
    await Bookmarks.removeGroup(group).catch(() => {});
}

const RESTORE_GROUP_PREFIX = 'restore-group-';

async function addUndoRemove(groupToRemove) {
    const restoreId = RESTORE_GROUP_PREFIX + groupToRemove.id;
    groupToRemove.subGroups = SubGroups.referencedSubGroups(groupToRemove);
    groupToRemove.tabs = Tabs.prepareForSave(groupToRemove.tabs, { includeFavIconUrl: true, includeThumbnail: false });

    try {
        await browser.storage.session.set({ [restoreId]: groupToRemove });
        await Menus.create({
            id: restoreId,
            title: Lang('undoRemoveGroupItemTitle', groupToRemove.title),
            contexts: [Menus.ContextType.BROWSER_ACTION],
            icons: getIconUrl(groupToRemove, 16),
            module: ['groups', 'restore', groupToRemove.id],
        });

        const {showNotificationAfterGroupDelete} = await Storage.get('showNotificationAfterGroupDelete');
        if (showNotificationAfterGroupDelete) {
            await Notification(['undoRemoveGroupNotification', groupToRemove.title], {
                id: restoreId,
                module: ['groups', 'restore', groupToRemove.id],
                expires: Notification.MAX_EXPIRES,
            });
        }
    } catch (error) {}
}

export function restore(...args) {
    return Operations.run('restore-group', () => restoreNow(...args));
}

async function restoreNow(groupId) {
    const restoreId = RESTORE_GROUP_PREFIX + groupId;
    await Menus.remove(restoreId);
    await Notification.clear(restoreId);

    const {[restoreId]: group} = await browser.storage.session.get(restoreId);
    if (!group) return;

    await browser.storage.session.remove(restoreId);

    await writeQueue.run('restore', async () => {
        const {groups, groupsById} = await load(null, true);
        const {index} = group;
        delete group.index;

        if (groupsById.has(group.id)) group.id = createId();
        SubGroups.reissueSubGroupIds(group, SubGroups.collectSubGroupIds(groups));

        groups.splice(index, 0, group);
        normalizeContainersInGroups(groups);
        NewCloudGroups.add(group.id);
        await saveNow(groups);
    });

    if (group.tabs.length && !group.isArchive) {
        await Browser.actionLoading();
        const creation = await Tabs.createMultiple(setNewTabsParams(group.tabs, group), {hideUnloaded: false});
        group.tabs = await settleTabs(group, group.tabs, creation);
        await Browser.actionLoading(false);
    }

    await MenusMain.groupAdded(group);
    sendAdded(group);
}

export function update(groupId, updateData) {
    return writeQueue.run('update', () => updateNow(groupId, updateData));
}

async function updateNow(groupId, updateData) {
    const {group, groupIndex, groups} = await load(groupId);
    if (!group) return;

    if (typeof updateData === 'function') updateData = updateData(group);
    if (updateData.iconUrl?.startsWith('chrome:')) delete updateData.iconUrl;

    const updateDataKeys = new Set(Object.keys(updateData));
    if (!updateDataKeys.size) return;

    if (updateDataKeys.has('title')) {
        const {defaultGroupProps} = await getDefaults();
        updateData.title = createTitle(updateData.title, groupId, defaultGroupProps).slice(0, 256);
        updateData.title = Utils.format(updateData.title, {index: groupIndex + 1});
    }

    if (!group.uploadToCloud && updateData.uploadToCloud === true) {
        NewCloudGroups.add(group.id);
    }

    Object.assign(group, updateData);
    await saveNow(groups);

    sendUpdated({ id: groupId, ...updateData }, group);

    if (updateDataKeys.intersection(KEYS_RESPONSIBLE_VIEW).size) {
        await Browser.actionGroup(group);
        await MenusMain.updateGroup(group).catch(() => {});
    }

    if (updateDataKeys.has('title')) {
        await Bookmarks.updateGroupTitle(group).catch(() => {});
    }

    if (updateDataKeys.has('exportToBookmarks')) {
        if (updateData.exportToBookmarks) {
            const {group: groupToExport} = await load(group.id, true);
            await Bookmarks.exportGroup(groupToExport).catch(() => {});
        } else {
            await Bookmarks.removeGroup(group).catch(() => {});
        }
    }
}

export async function move(groupId, newGroupIndex) {
    const groups = await writeQueue.run('move', async () => {
        const {groups, groupIndex} = await load(groupId);
        groups.splice(newGroupIndex, 0, groups.splice(groupIndex, 1)[0]);
        await saveNow(groups, true);
        return groups;
    });
    await MenusMain.groupsUpdated(groups);
}

export async function sort(vector = 'asc') {
    if (!['asc', 'desc'].includes(vector)) return;
    const groups = await writeQueue.run('sort', async () => {
        const {groups} = await load();
        if ('asc' === vector) groups.sort(Utils.sortBy('title'));
        else groups.sort(Utils.sortBy('title', undefined, true));
        await saveNow(groups, true);
        return groups;
    });
    await MenusMain.groupsUpdated(groups);
}

export async function showTabs(group = null, tabs = [], params) {
    await Tabs.show(tabs.filter(tab => tab.hidden), params);
    await Tabs.setMute(tabs, false, {onlyMutedBySelf: !group?.muteTabsWhenGroupCloseAndRestoreWhenOpen});
}

export async function hideTabs(group = null, tabs = [], params) {
    const tabsToHide = await pinSharingTabs(tabs.filter(tab => !Tabs.isPinned(tab)));
    await Tabs.hide(tabsToHide, params);

    if (group?.muteTabsWhenGroupCloseAndRestoreWhenOpen) {
        await Tabs.setMute(tabsToHide, true);
    } else {
        await Tabs.setMute(tabsToHide, false, {onlyMutedBySelf: true});
    }

    if (group?.discardTabsAfterHide) {
        if (group.discardExcludeAudioTabs) {
            await Tabs.discard(tabsToHide.filter(tab => !tab.audible), params);
        } else {
            await Tabs.discard(tabsToHide, params);
        }
    }
    return tabsToHide;
}

export async function pinSharingTabs(tabs) {
    const tabsToPin = tabs.filter(Tabs.isSharing);
    if (!tabsToPin.length) return tabs;

    await Tabs.pin(tabsToPin);
    await Promise.allSettled(tabsToPin.flatMap(tab => [
        Cache.removeTabGroup(tab.id),
        Cache.removeTabSubGroupId(tab.id),
    ]));

    let showNotif = mainStorage.thisTabsWerePinned ?? 0;
    if (showNotif < 3) {
        mainStorage.thisTabsWerePinned = ++showNotif;
        Notification(['thisTabsWerePinned', tabsToPin.map(tab => Tabs.getTitle(tab, false, 20)).join(', ')]);
    }
    return tabs.filter(tab => !tabsToPin.includes(tab));
}

export async function settleTabs(group, savedTabs, {live, aligned}) {
    let tabs = await Tabs.ensureSorted(live);
    const windowId = Cache.getWindowId(group.id);

    if (windowId) {
        const {group: loadedGroup} = await load(group.id, true);
        await SubGroups.apply(windowId, loadedGroup).catch(() => {});
    } else {
        tabs = await hideTabs(group, tabs);
    }

    await Tabs.applyOpeners(savedTabs, aligned);
    return tabs.map(Cache.applyTabSession);
}

export function unload(...args) {
    return Operations.run('unload-group', () => unloadNow(...args));
}

async function unloadNow(groupId) {
    if (!groupId) return false;
    const windowId = Cache.getWindowId(groupId);
    if (!windowId) return false;

    const {group} = await load(groupId, true);
    if (!group || group.isArchive) return false;

    await Browser.actionLoading();
    await Cache.removeWindowSession(windowId);

    const unsyncTabs = (await Tabs.query({windowId, hidden: true})).filter(tab => !tab.groupId);
    await showTabs(null, unsyncTabs);
    group.tabs = await hideTabs(group, group.tabs, {activateOther: true});

    await Browser.actionLoading(false);
    await MenusMain.groupUnloaded(group, windowId);
    sendUnloaded(groupId, windowId);
    return true;
}

export function archiveToggle(...args) {
    return Operations.run('archive-toggle', () => archiveToggleNow(...args));
}

async function archiveToggleNow(groupId) {
    await Browser.actionLoading();
    if (Cache.getWindowId(groupId)) {
        if (!await unload(groupId)) {
            await Browser.actionLoading(false);
            return null;
        }
    }

    const {group, tabsToRemove, savedTabs, creation} = await writeQueue.run('archive-toggle', async () => {
        const {group, groups} = await load(groupId, true);
        let tabsToRemove = [], savedTabs = null, creation = null;

        if (group.isArchive) {
            group.isArchive = false;
            savedTabs = group.tabs;
            creation = await Tabs.createMultiple(setNewTabsParams(savedTabs, group), {hideUnloaded: false});
            group.tabs = [];
        } else {
            tabsToRemove = group.tabs;
            group.isArchive = true;
            group.subGroups = SubGroups.referencedSubGroups(group);
            group.tabs = Tabs.prepareForSave(group.tabs, { includeFavIconUrl: true, includeThumbnail: true });
        }

        await saveNow(groups);
        return {group, tabsToRemove, savedTabs, creation};
    });

    if (creation) await settleTabs(group, savedTabs, creation);
    await Tabs.remove(tabsToRemove, {ungroupNative: false, keepWindowsAlive: false});
    sendUpdated(group, group);
    await Browser.actionLoading(false);
    await MenusMain.updateGroup(group);
}

export async function removeArchivedGroupsTabs(groups) {
    const archivedGroupIds = new Set(groups.filter(group => group.isArchive).map(group => group.id));
    if (!archivedGroupIds.size) return;

    const tabsToRemove = await Tabs.query({pinned: false}).then(tabs => tabs.filter(tab => archivedGroupIds.has(tab.groupId)));
    if (!tabsToRemove.length) return;

    await Tabs.remove(tabsToRemove);
}

export function mapForExternalExtension(group) {
    return {
        id: group.id,
        title: getTitle(group),
        isArchive: group.isArchive,
        isSticky: group.isSticky,
        iconUrl: getIconUrl(group),
        contextualIdentity: Containers.get(group.newTabContainer),
        windowId: Cache.getWindowId(group.id) || null,
    };
}

export function getContainerParams({newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen}) {
    return {newTabContainer, ifDifferentContainerReOpen, excludeContainersForReOpen};
}

export function getNewTabParams(group) {
    return {groupId: group.id, ...getContainerParams(group)};
}

export function setNewTabsParams(tabs, group) {
    const newTabParams = getNewTabParams(group);
    return tabs.map(tab => Object.assign(tab, newTabParams));
}

function isCatchedUrl(url, catchTabRules) {
    return catchTabRules
        .split(/\s*\n\s*/)
        .map(regExpStr => regExpStr.trim())
        .filter(Boolean)
        .some(regExpStr => {
            try { return new RegExp(regExpStr).test(url); } catch {}
        });
}

export function normalizeContainersInGroups(groups) {
    const allContainers = Containers.query({defaultContainer: true, temporaryContainer: true});
    let hasChanges = false;

    for (const group of groups) {
        const oldNewTabContainer = group.newTabContainer,
              oldCatchLen = group.catchTabContainers.length,
              oldExclLen = group.excludeContainersForReOpen.length;

        group.newTabContainer = Containers.get(group.newTabContainer).cookieStoreId;
        group.catchTabContainers = group.catchTabContainers.filter(id => allContainers[id]);
        group.excludeContainersForReOpen = group.excludeContainersForReOpen.filter(id => allContainers[id]);

        if (oldNewTabContainer !== group.newTabContainer || oldCatchLen !== group.catchTabContainers.length || oldExclLen !== group.excludeContainersForReOpen.length) {
            hasChanges = true;
            if (mainStorage.inited) {
                sendUpdated({
                    id: group.id,
                    newTabContainer: group.newTabContainer,
                    catchTabContainers: group.catchTabContainers,
                    excludeContainersForReOpen: group.excludeContainersForReOpen,
                }, group);
            }
        }
    }
    return hasChanges;
}

export function getCatchedForTab(notArchivedGroups, currentGroup, {cookieStoreId, url}) {
    if (currentGroup.isSticky) return;

    const destGroup = notArchivedGroups.find(({catchTabContainers, catchTabRules}) => {
        return catchTabContainers.includes(cookieStoreId) || isCatchedUrl(url, catchTabRules);
    });

    if (destGroup) {
        if (destGroup.id === currentGroup.id) return;
        return destGroup;
    }

    if (currentGroup.catchTabRules && currentGroup.moveToGroupIfNoneCatchTabRules) {
        return notArchivedGroups.find(group => group.id === currentGroup.moveToGroupIfNoneCatchTabRules);
    }
}

export function isNeedBlockBeforeRequest(groups) {
    return groups.some(({isArchive, catchTabContainers, catchTabRules, ifDifferentContainerReOpen, newTabContainer}) => {
        if (isArchive) return false;
        return catchTabContainers.length || catchTabRules || ifDifferentContainerReOpen || newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID;
    });
}

export async function setIconUrl(groupId, iconUrl) {
    try {
        await update(groupId, {
            iconViewType: null,
            iconUrl: await Utils.normalizeGroupIcon(iconUrl),
        });
    } catch (e) {
        Notification(e);
    }
}

const firstCharEmojiRegExp = /^\p{RGI_Emoji}/v;

export function getEmojiIcon(group) {
    if (group.iconViewType === 'title') {
        const [emoji] = firstCharEmojiRegExp.exec(group.title) || [];
        return emoji;
    }
}

const UNKNOWN_GROUP_ICON_PROPS = {
    title: '❓',
    iconViewType: 'title',
    iconColor: 'gray',
};

export function getIconUrl(group, keyInObj = null) {
    group ??= UNKNOWN_GROUP_ICON_PROPS;
    let result = null;

    if (group.iconUrl) {
        result = group.iconUrl;
    } else {
        const iconColor = group.iconColor || 'transparent';
        let svg = Constants.GROUP_ICON_VIEW_TYPES[group.iconViewType];

        switch (group.iconViewType) {
            case 'main-squares':
                if (iconColor !== 'transparent') svg = svg.replace('transparent', iconColor);
                break;
            case 'circle':
                svg = svg.replace('fill=""', `fill="${iconColor}"`);
                if (iconColor === 'transparent') svg = svg.replace('stroke-width="0"', 'stroke-width="1"');
                break;
            case 'squares':
            case 'old-tab-groups':
                if (iconColor !== 'transparent') svg = svg.replace('fill=""', `fill="${iconColor}"`);
                break;
            case 'title':
                const emoji = getEmojiIcon(group);
                svg = svg.replace('position=""', emoji ? 'text-anchor="middle" x="50%"' : 'x="0"').replace('text-content', emoji || group.title);
                if (iconColor !== 'transparent') svg = svg.replace('fill=""', `fill="${iconColor}"`);
                break;
        }

        try {
            result = Utils.convertSvgToUrl(svg.trim());
        } catch {
            result = getIconUrl(UNKNOWN_GROUP_ICON_PROPS);
        }
    }

    return keyInObj ? {[keyInObj]: result} : result;
}

export function createTitle(title = null, groupId = null, defaultGroupProps = {}, format = true) {
    const uid = groupId?.slice(-4) || '{uid}';
    if (title) title = String(title);
    else if (defaultGroupProps.title) title = defaultGroupProps.title;
    else title = Lang('newGroupTitle', uid);

    return format ? Utils.format(title, {uid}, Utils.DATE_LOCALE_VARIABLES) : title;
}

export function getTitle({id, title, isArchive, isSticky, tabs, iconViewType, newTabContainer}, args = '') {
    const withActiveGroup = args.includes('withActiveGroup');
    const withCountTabs = args.includes('withCountTabs');
    const withContainer = args.includes('withContainer');
    const withSticky = args.includes('withSticky');
    const withTabs = args.includes('withTabs');
    const beforeTitle = [];

    if (withSticky && isSticky) beforeTitle.push(Constants.STICKY_SYMBOL);
    if (withContainer && newTabContainer !== Constants.DEFAULT_COOKIE_STORE_ID) beforeTitle.push('[' + Containers.get(newTabContainer).name + ']');

    if (withActiveGroup) {
        if (Cache.getWindowId(id)) beforeTitle.push(Constants.ACTIVE_SYMBOL);
        else if (isArchive) beforeTitle.push(Constants.DISCARDED_SYMBOL);
    }

    if (iconViewType === 'title') title = title.replace(firstCharEmojiRegExp, '');
    if (beforeTitle.length) title = beforeTitle.join(' ') + ' ' + title;
    if (withCountTabs) title += ' (' + tabsCountMessage(tabs.slice(), isArchive) + ')';

    if (withTabs && tabs.length) {
        title += ':\n' + tabs.slice(0, 30).map(tab => Tabs.getTitle(tab, false, 70, !isArchive)).join('\n');
        if (tabs.length > 30) title += '\n...';
    }

    return title;
}

export function tabsCountMessage(tabs, groupIsArchived, lang = true) {
    if (groupIsArchived) return lang ? Lang('groupTabsCount', tabs.length) : tabs.length;
    const activeTabsCount = tabs.filter(tab => !tab.discarded).length;
    if (lang) return Lang('groupTabsCountActive', [activeTabsCount, tabs.length]);
    return activeTabsCount ? (activeTabsCount + '/' + tabs.length) : tabs.length;
}

export function getMenuId(groupId, context) {
    return `${context}-${groupId}`;
}

export async function getMenuProperties(group, context, {showArchivedGroups}) {
    return {
        id: getMenuId(group.id, context),
        title: getTitle(group, 'withSticky withActiveGroup withContainer'),
        icon: getIconUrl(group),
        enabled: !group.isArchive,
        visible: !group.isArchive ? true : showArchivedGroups,
    };
}
