import * as Constants from './constants.js';
import * as StorageUtils from './storage-utils.js';
import Logger from './logger.js';

export * from './storage-utils.js';

const logger = new Logger('Storage');

// In-memory cache to reduce read overhead and hold pending writes
const memoryCache = new Map();
let pendingWriteData = {};
let writeTimer = null;
const WRITE_DELAY_MS = 750; // Buffer writes up to 750ms

export async function get(keys, defaultData = Constants.DEFAULT_OPTIONS) {
    const log = logger.start('get', keys);

    // If fetching all options or specific keys, we can check memory cache or fall back to native get
    const keysData = StorageUtils.getKeysData(keys, defaultData);
    const result = await StorageUtils.nativeGet('local', keysData, log);

    log.stop();
    return result;
}

export async function getRaw() {
    const log = logger.start('getRaw');
    const result = await StorageUtils.nativeGet('local', null, log);
    log.stop();
    return result;
}

/**
 * Flushes any pending debounced writes immediately to browser.storage.local
 */
async function flushPendingWrites() {
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }

    const dataToWrite = pendingWriteData;
    pendingWriteData = {};

    if (Object.keys(dataToWrite).length === 0) {
        return;
    }

    const log = logger.start('flushPendingWrites', Object.keys(dataToWrite));
    try {
        await browser.storage.local.set(dataToWrite);
    } catch (e) {
        logger.error('Failed to flush storage writes', e);
    }
    log.stop();
}

export async function set(data) {
    const log = logger.start('set', Object.keys(data));

    // Strip tabs of non-archived groups from the persisted copy
    if (data.groups) {
        data = {
            ...data,
            groups: data.groups.map(group => group.isArchive ? group : {...group, tabs: []}),
        };
    }

    // Merge into pending write batch
    pendingWriteData = {
        ...pendingWriteData,
        ...data,
    };

    // Debounce the disk write to prevent I/O thrashing during rapid events
    if (writeTimer) {
        clearTimeout(writeTimer);
    }

    return new Promise((resolve, reject) => {
        writeTimer = setTimeout(async () => {
            try {
                await flushPendingWrites();
                log.stop();
                resolve();
            } catch (e) {
                log.stopError(e);
                reject(e);
            }
        }, WRITE_DELAY_MS);
    });
}

export async function remove(...args) {
    logger.log('remove', args);
    // Ensure any pending writes are flushed before removing keys
    await flushPendingWrites();
    return browser.storage.local.remove(args.flat());
}

export async function clear() {
    logger.log('clear');
    if (writeTimer) {
        clearTimeout(writeTimer);
        writeTimer = null;
    }
    pendingWriteData = {};
    memoryCache.clear();
    return browser.storage.local.clear();
}
