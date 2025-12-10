document.addEventListener('DOMContentLoaded', () => {
    const versionEl = document.getElementById('manualVersion');
    if (versionEl) {
        versionEl.innerText = 'v' + chrome.runtime.getManifest().version;
    }
});