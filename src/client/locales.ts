/**
 * Locale copy for the OpenAI Codex settings card.
 *
 * @module dsh-openai-codex/client/locales
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'

/** The locale namespace owning the card's copy. */
export const NS = 'settings.openaiCodex'

/** Copy keys for the card. */
export type CodexKey =
  | 'title'
  | 'description'
  | 'expand'
  | 'collapse'
  | 'signedIn'
  | 'signedOut'
  | 'authenticateBrowser'
  | 'authenticateDevice'
  | 'signOut'
  | 'busy'
  | 'loginError'
  | 'deviceIntro'
  | 'deviceCode'
  | 'verifyUrl'
  | 'devicePending'
  | 'deviceDone'
  | 'manualUrlHint'

export const en: Record<CodexKey, string> = {
  title: 'OpenAI Codex',
  description: 'Authenticate with your ChatGPT subscription to use OpenAI Codex models as an LLM provider.',
  expand: 'Expand',
  collapse: 'Collapse',
  signedIn: 'Signed in',
  signedOut: 'Not authenticated',
  authenticateBrowser: 'Authenticate (browser)',
  authenticateDevice: 'Authenticate (device code)',
  signOut: 'Sign out',
  busy: 'Working…',
  loginError: 'Authentication failed',
  deviceIntro: 'Open the verification URL and enter this code:',
  deviceCode: 'Code',
  verifyUrl: 'Verification URL',
  devicePending: 'Waiting for you to authorize…',
  deviceDone: 'Authorization complete — you can close the card.',
  manualUrlHint: 'If no browser opened, open the URL below and paste the redirect URL back here.',
}

export const zh: Record<CodexKey, string> = {
  title: 'OpenAI Codex',
  description: '使用你的 ChatGPT 订阅进行身份验证，即可将 OpenAI Codex 模型作为 LLM 提供商。',
  expand: '展开',
  collapse: '收起',
  signedIn: '已登录',
  signedOut: '未认证',
  authenticateBrowser: '认证（浏览器）',
  authenticateDevice: '认证（设备码）',
  signOut: '退出登录',
  busy: '处理中…',
  loginError: '认证失败',
  deviceIntro: '打开验证链接并输入此代码：',
  deviceCode: '代码',
  verifyUrl: '验证链接',
  devicePending: '等待你授权…',
  deviceDone: '授权完成 —— 可以关闭此卡片。',
  manualUrlHint: '如果浏览器没有打开，请打开下方链接，并将重定向 URL 粘贴回来。',
}
