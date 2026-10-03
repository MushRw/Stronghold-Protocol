// Self-hosted sign-in: a callsign plus a password, reviewed by the operator. Deliberately its own
// component so the title screen and the in-game account menu stay readable, and so a deployment that
// keeps GitHub OAuth never shows it.
import { useState } from '../../vendor/hooks.module.js';
import { html, Button, TextField } from './components.js';
import { account, accountRequest, loadAccount } from '../account.js';
import { net, identity } from '../net.js';
import { store } from '../store.js';
import { toast } from './toasts.js';

const LOGIN_MAX = 24;
const PASS_MAX = 128;

export function LocalAuthForm({ onDone, compact = false, autoFocus = false }) {
  const [mode, setMode] = useState('login');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');

  const submit = async (event) => {
    event?.preventDefault?.();
    if (busy) return;
    const name = login.trim();
    if (!name || password.length < 8) {
      setNotice(name ? '密码至少 8 位' : '先填代号');
      return;
    }
    setBusy(true);
    setNotice('');
    try {
      if (mode === 'register') {
        await accountRequest('/api/auth/register', { login: name, password });
        setNotice('已提交，等房主在审核页批准后就能登录。');
        setPassword('');
        return;
      }
      await accountRequest('/api/auth/login', { login: name, password });
      await loadAccount();
      // The identity the socket greets with must be the reviewed one, so drop any stale nickname.
      if (account.user?.name) store.patch('session', { name: account.user.name });
      net.close();
      onDone ? onDone() : location.reload();
    } catch (e) {
      // A rejected account must not be told to wait for approval.
      setNotice(e.code === 'NOT_APPROVED' && e.status === 'rejected'
        ? '这个账号已被拒绝，如果认为是误判，请联系房主。'
        : e.message);
      if (e.code === 'NOT_APPROVED') { setMode('login'); setPassword(''); }
    } finally {
      setBusy(false);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setNotice('');
    setPassword('');
  };

  return html`<form class=${'local-auth' + (compact ? ' local-auth--compact' : '')} onSubmit=${submit}>
    <${TextField} label="代号" micro="CALLSIGN" size=${compact ? 'md' : 'lg'} icon="user" value=${login}
      maxLength=${LOGIN_MAX} placeholder="别人看到的名字" autoFocus=${autoFocus} disabled=${busy}
      onInput=${setLogin} onEnter=${submit} />
    <${TextField} label="密码" micro="PASSWORD" size=${compact ? 'md' : 'lg'} icon="key" type="password"
      autocomplete=${mode === 'register' ? 'new-password' : 'current-password'} value=${password}
      maxLength=${PASS_MAX} placeholder="至少 8 位" disabled=${busy} onInput=${setPassword} onEnter=${submit} />
    ${notice ? html`<p class="local-auth__notice" role="status">${notice}</p>` : null}
    <div class="local-auth__row">
      <${Button} variant="primary" size=${compact ? 'md' : 'xl'} block=${true} type="submit" loading=${busy}
        disabled=${busy}>${mode === 'register' ? '注册并等待审核' : '登录'}<//>
      <${Button} variant="ghost" size=${compact ? 'md' : 'lg'} disabled=${busy}
        onClick=${() => switchMode(mode === 'register' ? 'login' : 'register')}>
        ${mode === 'register' ? '已有账号，去登录' : '没有账号，去注册'}<//>
    </div>
  </form>`;
}

/** Entry point for both screens: GitHub when the deployment configured it, local accounts otherwise. */
export function AccountSignIn({ compact = false, onDone, autoFocus = false }) {
  if (account.localAuth) return html`<${LocalAuthForm} compact=${compact} autoFocus=${autoFocus} onDone=${onDone} />`;
  return html`<${Button} variant="primary" size=${compact ? 'md' : 'xl'} block=${true} disabled=${!account.loginReady}
    onClick=${() => location.assign('/api/auth/github/start')}>${account.loginReady ? '使用 GitHub 登录' : '登录尚未配置'}<//>`;
}

export function resumeSession() {
  net.close();
  identity.setEntered(false);
  toast('已退出登录', 'ok');
  location.reload();
}
