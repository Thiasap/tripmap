// 页面共用的小工具（无构建步骤，由各页面直接引入）
function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char]));
}

function reportError(error) {
  alert(error?.message || String(error));
}
