export function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  // The browser reads the URL after click() returns; revoking it at once can cancel the save.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
