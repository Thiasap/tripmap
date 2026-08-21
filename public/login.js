// 只允许站内路径，防开放重定向（?redirect=https://evil.com 或 //evil.com）
function safeRedirect(value) {
  if (value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value;
  return '/';
}

const form = document.querySelector('#loginForm');
const errorEl = document.querySelector('#loginError');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: form.elements.password.value })
    });
    if (res.ok) {
      const params = new URLSearchParams(window.location.search);
      window.location.href = safeRedirect(params.get('redirect'));
    } else {
      errorEl.textContent = '密码错误';
      errorEl.style.display = 'block';
    }
  } catch {
    errorEl.textContent = '登录请求失败，请重试';
    errorEl.style.display = 'block';
  }
});
