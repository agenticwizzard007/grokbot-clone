/** Native shells identify themselves without exposing a privileged JavaScript bridge. */
export const isNativeApp = /SwarmNative\//.test(navigator.userAgent);
if (isNativeApp) document.documentElement.dataset.native = 'true';
