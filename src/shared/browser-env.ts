export function isWeChatBrowser() {
  return /MicroMessenger/i.test(navigator.userAgent || '');
}

export function isWeChatMiniProgramWebView() {
  return window.__wxjs_environment === 'miniprogram' || /miniProgram/i.test(navigator.userAgent || '');
}
