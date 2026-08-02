async function showCliInstallResult(dialog, result) {
  if (result.ok) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'chatdump command installed',
      message: 'chatdump command installed',
      detail: `chatdump command installed at ${result.path}. Try: chatdump list`,
    });
    return;
  }
  if (result.reason === 'cancelled') return;
  await dialog.showMessageBox({
    type: 'error',
    title: 'Could not install chatdump command',
    message: 'Could not install chatdump command',
    detail: result.message || 'Unknown error',
  });
}

module.exports = { showCliInstallResult };
