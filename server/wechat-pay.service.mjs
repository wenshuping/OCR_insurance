export function createMockJsapiPayParams(order) {
  return {
    appId: 'mock-wechat-appid',
    timeStamp: String(Math.floor(Date.now() / 1000)),
    nonceStr: `mock_${order.id}`,
    package: `prepay_id=mock_${order.outTradeNo}`,
    signType: 'RSA',
    paySign: `mock_sign_${order.id}`,
  };
}
