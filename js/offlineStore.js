const databaseName = "FarmerMobileOffline";
const databaseVersion = 3;
const storeNames = ["entities", "outbox", "evidence", "metadata"];
let databasePromise;
const unlockedAuthenticationKeys = new Map();

function openDatabase() {
    if (!databasePromise) {
        databasePromise = new Promise((resolve, reject) => {
            const request = indexedDB.open(databaseName, databaseVersion);

            request.onupgradeneeded = event => {
                const database = request.result;
                for (const storeName of storeNames) {
                    if (!database.objectStoreNames.contains(storeName)) {
                        database.createObjectStore(storeName, { keyPath: "id" });
                    }
                }

                const transaction = event.target.transaction;
                const entities = transaction.objectStore("entities");
                const outbox = transaction.objectStore("outbox");
                ensureIndex(entities, "partitionId", "value.partitionId");
                ensureIndex(entities, "cachedAt", "value.cachedAt");
                ensureIndex(outbox, "partitionId", "value.partitionId");
                ensureIndex(outbox, "status", "value.status");
                ensureIndex(outbox, "queuedAt", "value.queuedAt");
                ensureIndex(outbox, "idempotencyKey", "value.idempotencyKey");
            };

            request.onsuccess = () => resolve(request.result);
            request.onerror = () => {
                databasePromise = undefined;
                reject(request.error ?? new Error("Unable to open offline storage."));
            };
            request.onblocked = () => {
                databasePromise = undefined;
                reject(new Error("Offline storage upgrade is blocked by another app tab."));
            };
        });
    }

    return databasePromise;
}

function ensureIndex(store, name, keyPath) {
    if (!store.indexNames.contains(name)) {
        store.createIndex(name, keyPath, { unique: false });
    }
}

function assertStoreName(storeName) {
    if (!storeNames.includes(storeName)) {
        throw new Error(`Unknown offline storage area: ${storeName}`);
    }
}

export async function get(storeName, id) {
    assertStoreName(storeName);
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).get(id);
        request.onsuccess = () => resolve(request.result?.value ?? null);
        request.onerror = () => reject(request.error ?? new Error("Unable to read offline data."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Offline read was aborted."));
    });
}

export async function getAll(storeName) {
    assertStoreName(storeName);
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result.map(record => record.value));
        request.onerror = () => reject(request.error ?? new Error("Unable to read offline data."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Offline read was aborted."));
    });
}

export async function getAllByIndex(storeName, indexName, key) {
    assertStoreName(storeName);
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readonly");
        const request = transaction.objectStore(storeName).index(indexName).getAll(key);
        request.onsuccess = () => resolve(request.result.map(record => record.value));
        request.onerror = () => reject(request.error ?? new Error("Unable to read indexed offline data."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Indexed offline read was aborted."));
    });
}

export async function put(storeName, id, value) {
    assertStoreName(storeName);
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).put({ id, value });
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to save offline data."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Offline write was aborted."));
    });
}

export async function deleteRecord(storeName, id) {
    assertStoreName(storeName);
    const database = await openDatabase();

    return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, "readwrite");
        transaction.objectStore(storeName).delete(id);
        transaction.oncomplete = () => resolve(true);
        transaction.onerror = () => reject(transaction.error ?? new Error("Unable to delete offline data."));
        transaction.onabort = () => reject(transaction.error ?? new Error("Offline delete was aborted."));
    });
}

export async function saveEncryptedAuthenticationSession(username, password, session) {
    const id = await getAuthenticationStorageKey(username);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveAuthenticationKey(password, salt);
    const envelope = await encryptAuthenticationSession(id, key, salt, session);
    await put("metadata", id, envelope);
    unlockedAuthenticationKeys.set(id, { key, salt });
}

export async function unlockEncryptedAuthenticationSession(username, password) {
    const id = await getAuthenticationStorageKey(username);
    const envelope = await get("metadata", id);
    if (!envelope) return null;
    if (envelope.version !== 1 || envelope.storageKey !== id) return null;

    const salt = decodeBase64(envelope.salt);
    const key = await deriveAuthenticationKey(password, salt);
    try {
        const plaintext = await crypto.subtle.decrypt(
            {
                name: "AES-GCM",
                iv: decodeBase64(envelope.iv),
                additionalData: new TextEncoder().encode(id)
            },
            key,
            decodeBase64(envelope.ciphertext));
        const session = JSON.parse(new TextDecoder().decode(plaintext));
        unlockedAuthenticationKeys.set(id, { key, salt });
        return session;
    } catch (error) {
        if (error instanceof DOMException && error.name === "OperationError") return null;
        throw error;
    }
}

export async function updateEncryptedAuthenticationSession(username, session) {
    const id = await getAuthenticationStorageKey(username);
    const unlocked = unlockedAuthenticationKeys.get(id);
    if (!unlocked) {
        throw new Error("Unlock the offline session with the account password before updating tokens.");
    }

    const envelope = await encryptAuthenticationSession(id, unlocked.key, unlocked.salt, session);
    await put("metadata", id, envelope);
}

export async function deleteEncryptedAuthenticationSession(username) {
    const id = await getAuthenticationStorageKey(username);
    unlockedAuthenticationKeys.delete(id);
    await deleteRecord("metadata", id);
}

async function getAuthenticationStorageKey(username) {
    if (typeof username !== "string" || username.trim().length === 0) {
        throw new Error("A username is required for offline authentication.");
    }
    const normalizedUsername = username.trim().toLocaleLowerCase("en-US");
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizedUsername));
    return `auth:${encodeBase64(new Uint8Array(digest))}`;
}

async function deriveAuthenticationKey(password, salt) {
    if (typeof password !== "string" || password.length === 0) {
        throw new Error("A password is required for offline authentication.");
    }
    const material = await crypto.subtle.importKey(
        "raw",
        new TextEncoder().encode(password),
        "PBKDF2",
        false,
        ["deriveKey"]);
    return crypto.subtle.deriveKey(
        { name: "PBKDF2", salt, iterations: 310000, hash: "SHA-256" },
        material,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"]);
}

async function encryptAuthenticationSession(id, key, existingSalt, session) {
    const salt = existingSalt ?? crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(session));
    const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
        key,
        plaintext);
    return {
        version: 1,
        storageKey: id,
        salt: encodeBase64(salt),
        iv: encodeBase64(iv),
        ciphertext: encodeBase64(new Uint8Array(ciphertext)),
        updatedAt: new Date().toISOString()
    };
}

function encodeBase64(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
}

function decodeBase64(value) {
    const binary = atob(value);
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}
