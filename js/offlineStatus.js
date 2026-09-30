let callback;

export function isOnline() {
    return navigator.onLine;
}

export function subscribe(dotNetReference) {
    callback = () => {
        dotNetReference.invokeMethodAsync("ConnectivityChanged", navigator.onLine)
            .catch(error => console.error("Farmer Mobile connectivity update failed.", error));
    };

    window.addEventListener("online", callback);
    window.addEventListener("offline", callback);
    callback();
}

export function unsubscribe() {
    if (!callback) return;
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
    callback = undefined;
}
