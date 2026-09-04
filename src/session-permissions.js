const LOCAL_NETWORK_PERMISSIONS = new Set([
  'local-network',
  'local-network-access',
  'loopback-network',
]);

function isLocalNetworkPermission(permission) {
  return LOCAL_NETWORK_PERMISSIONS.has(permission);
}

// Provider pages run inside Electron sessions. Deny Chromium's local-network
// permissions before remote content can make a LAN or loopback request that
// would cause macOS to show the Local Network privacy prompt. Electron grants
// unhandled permission requests by default, so preserve that behavior for all
// unrelated permissions used by provider login flows.
function configureProviderSessionPermissions(ses) {
  ses.setPermissionCheckHandler((_webContents, permission) => {
    return !isLocalNetworkPermission(permission);
  });
  ses.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(!isLocalNetworkPermission(permission));
  });
  return ses;
}

// Electron currently disables Chromium's LocalNetworkAccessChecks feature, so
// the permission handlers above are not sufficient on their own. Prevent the
// provider page's WebRTC stack from enumerating local interfaces or opening
// direct UDP sockets, either of which can trigger macOS Local Network privacy.
function configureProviderWebContents(webContents) {
  webContents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  return webContents;
}

module.exports = {
  configureProviderSessionPermissions,
  configureProviderWebContents,
  _test: { isLocalNetworkPermission },
};
