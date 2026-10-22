import * as Utils from './utils.js';

export default class GroupsHistory {
    static #STORAGE_KEY = 'groups-history';

    async fill(windows) {
        await Promise.all(windows
            .filter(({groupId}) => groupId)
            .map(async ({id: windowId, groupId}) => {
                const history = await this.#load(windowId);

                if (!history.groupIds.includes(groupId)) {
                    history.groupIds = history.groupIds
                        .slice(0, history.index + 1)
                        .filter(savedGroupId => savedGroupId !== groupId);
                    history.index = history.groupIds.push(groupId) - 1;
                    await this.#save(windowId, history);
                }
            })
        );
    }

    async add(windowId, groupId) {
        const history = await this.#load(windowId);

        if (history.groupIds[history.index] === groupId) {
            return;
        }

        history.groupIds = history.groupIds
            .slice(0, history.index + 1)
            .filter(savedGroupId => savedGroupId !== groupId);

        history.index = history.groupIds.push(groupId) - 1;

        await this.#save(windowId, history);
    }

    async move(windowId, groups, direction) {
        const history = await this.#load(windowId);

        this.#normalize(history, groups);

        const groupIdBefore = history.groupIds[history.index];
        history.index = Utils.getNextIndex(history.index, history.groupIds.length, direction);
        const groupIdAfter = history.groupIds[history.index];

        if (groupIdBefore === groupIdAfter) {
            return null;
        }

        await this.#save(windowId, history);

        return groupIdAfter;
    }

    #normalize(history, groups) {
        const actualGroupIds = new Set(groups.map(({id}) => id));
        const currentGroupId = history.groupIds[history.index];

        history.groupIds = history.groupIds.filter(groupId => actualGroupIds.has(groupId));
        const currentGroupIndex = history.groupIds.indexOf(currentGroupId);

        history.index = currentGroupIndex !== -1
            ? currentGroupIndex
            : history.groupIds.length - 1;
    }

    #createHistory() {
        return {
            index: -1,
            groupIds: [],
        };
    }

    async #load(windowId) {
        let history = await browser.sessions.getWindowValue(windowId, GroupsHistory.#STORAGE_KEY);
        history ??= this.#createHistory();

        return history;
    }

    async #save(windowId, history) {
        if (history.groupIds.length) {
            await browser.sessions.setWindowValue(windowId, GroupsHistory.#STORAGE_KEY, history);
        } else {
            await browser.sessions.removeWindowValue(windowId, GroupsHistory.#STORAGE_KEY);
        }
    }
}
