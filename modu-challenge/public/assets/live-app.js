import { setupEntityUi, openEntityCases, entityAction, entityForm } from './entity-ui.js?v=61';
import { legacyNotificationText } from './brand.js?v=61';
import { CATEGORY_META, STATUS_META, FUNDING_META } from './data.js?v=61';
import { calculateSettlement } from './business-rules.js?v=61';
import { ApiError, apiClient, createPasswordMaterial } from './api-client.js?v=61';

/**
 * 모두의클리어 live frontend
 * © 2026 ISEA GROUP. All Rights Reserved.
 */

setupEntityUi({openModal});
const main = document.querySelector('#main');
const modalRoot = document.querySelector('#modal-root');
const toastRoot = document.querySelector('#toast-root');
const notice = document.querySelector('#system-notice');
let heroRotationTimer = null;
let activityPollTimer = null;
let activityPollBusy = false;
let modalScrollY = 0;
let deferredInstallPrompt = null;
let modalHistoryEntry = false;

const state = {
  activityFocus: null,
  route: routeFromHash(),
  config: null,
  health: null,
  user: null,
  challenges: [],
  activity: null,
  trustProfile: null,
  verifications: null,
  adminOverview: null,
  previewHomeTheme: null,
  emailVerification: null,
  selectedChallenge: null,
  category: 'ALL',
  search: '',
  sort: 'new',
  createMode: 'easy',
  createDraft: null,
  routeError: null,
  simulations: [],
  simulation: null,
  simulationRole: 'owner',
  loading: true,
  apiAvailable: true,
};

const HOME_THEME_OPTIONS = [
  { id: 'original', title: '오리지널 네이비', detail: '현재 사용 중인 선명한 미션 마켓 디자인' },
  { id: 'luxury', title: '01 · 프리미엄 매거진', detail: '아이보리·딥그린의 사진 중심 메인페이지' },
  { id: 'community', title: '02 · 커뮤니티 마켓', detail: '카테고리와 인기 미션을 먼저 만나는 화면' },
  { id: 'command', title: '03 · 미션 커맨드', detail: '실시간 미션 목록과 연결 지도를 강조' },
  { id: 'magazine', title: '04 · 에디토리얼', detail: '큰 제목과 번호가 있는 미션 목록' },
  { id: 'journey', title: '05 · 클리어 여정', detail: '함께 해결하는 과정과 보상 기회를 강조' },
  { id: 'emerald', title: '에메랄드 프리미엄', detail: '딥그린과 골드의 고급스러운 무대' },
  { id: 'editorial', title: '아이보리 에디토리얼', detail: '넓은 여백과 읽기 쉬운 매거진 화면' },
  { id: 'sunset', title: '코랄 선셋', detail: '밝고 따뜻한 참여형 커뮤니티' },
  { id: 'cobalt', title: '코발트 스튜디오', detail: '대담한 블루와 그래픽 중심 레이아웃' },
];

function isLocalMoneySimulation() {
  return ['development', 'test'].includes(String(state.config?.environment || '').toLowerCase());
}

function isMoneyFlowAvailable() {
  return Boolean(state.config?.moneyEnabled) || isLocalMoneySimulation();
}

init().catch((error) => fatal(error));

async function init() {
  bindGlobalEvents();
  bindWebAppInstall();
  window.addEventListener('hashchange', async () => {
    state.route = routeFromHash();
    if (state.route === 'verify-email') await verifyEmailFromLink();
    normalizeSignedInRoute();
    if (state.route === 'reset-password') state.routeError = null;
    await loadRouteData();
    render();
    openDirectAuthRoute();
    if (state.route === 'social-signup') await openSocialSignup().catch(showError);
    await openDeepLinkedChallenge();
    window.scrollTo({ top: 0, behavior: 'instant' });
  });
  window.addEventListener('popstate', () => {
    if (modalRoot.innerHTML && modalHistoryEntry) closeModal({ fromHistory: true });
  });
  window.addEventListener('focus', () => refreshDashboardActivity());
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDashboardActivity();
  });

  try {
    const [bootstrap, currentUser] = await Promise.all([
      loadBootstrapData(),
      loadCurrentUser(),
    ]);
    state.config = bootstrap.config;
    state.health = bootstrap.health;
    state.challenges = bootstrap.challenges || [];
    state.user = currentUser;
  } catch (error) {
    state.apiAvailable = false;
    state.loading = false;
    renderOffline(error);
    return;
  }

  if (state.user && new URLSearchParams(location.search).has('identityVerificationId')) await completeIdentityRedirect();
  if (state.route === 'verify-email') await verifyEmailFromLink();
  normalizeSignedInRoute();
  if (state.route === 'reset-password') state.routeError = null;

  await loadRouteData();
  state.loading = false;
  renderSystemNotice();
  render();
  openDirectAuthRoute();
  if (state.route === 'social-signup') await openSocialSignup().catch(showError);
  await openDeepLinkedChallenge();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    let hadController = Boolean(navigator.serviceWorker.controller);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (!modalRoot.innerHTML && state.route !== 'create') location.reload();
      else {
        const button = document.createElement('button');
        button.className = 'pwa-update-button';
        button.textContent = '모두의클리어 업데이트 · 입력을 마친 뒤 적용';
        button.addEventListener('click', () => { modalRoot.querySelectorAll('form').forEach(saveTransientModalDraft); location.reload(); });
        document.body.append(button);
      }
    });
    navigator.serviceWorker.register('/sw.js?v=61').then((registration) => {
      registration.update().catch(() => undefined);
      registration.addEventListener('updatefound', () => {
        registration.installing?.addEventListener('statechange', () => {
          if (registration.waiting && navigator.serviceWorker.controller) {
            registration.waiting.postMessage({ type: 'SKIP_WAITING' });
          }
        });
      });
    }).catch(() => undefined);
  }
}

async function loadCurrentUser() {
  const oauthReturn = location.hash.includes('oauth=success');
  try {
    const result = await apiClient.me();
    if (result.user || !oauthReturn) return result.user;
    // Some Android WebViews commit the OAuth session cookie just after the
    // callback page finishes. Retry briefly so the app does not render a
    // successful return as a logged-out session.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 180));
      const retry = await apiClient.me();
      if (retry.user) return retry.user;
    }
    return null;
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status) && oauthReturn) {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 180));
        try {
          const retry = await apiClient.me();
          if (retry.user) return retry.user;
        } catch (retryError) {
          if (!(retryError instanceof ApiError) || ![401, 403].includes(retryError.status)) throw retryError;
        }
      }
      return null;
    }
    if (error instanceof ApiError && [401, 403].includes(error.status)) return null;
    else throw error;
  }
}

async function loadBootstrapData() {
  try {
    return await apiClient.bootstrap();
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) throw error;
    const [config, health, challengeData] = await Promise.all([
      apiClient.config(),
      apiClient.health(),
      apiClient.listChallenges({ limit: 50, sort: state.sort }),
    ]);
    return { config, health, challenges: challengeData.challenges || [] };
  }
}

async function loadChallenges() {
  const result = await apiClient.listChallenges({ limit: 50, sort: state.sort });
  state.challenges = result.challenges || [];
}

async function loadRouteData() {
  if (!state.apiAvailable) return;
  state.routeError = null;
  try {
    if (state.route === 'simulation' && state.user?.isAdmin) {
      const result = await apiClient.listSimulations();
      state.simulations = result.simulations;
      const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
      state.simulation = id ? (await apiClient.getSimulation(id)).simulation : null;
    }
    if (state.route === 'dashboard' && state.user) {
      state.activity = await apiClient.activity();
    }
    if (state.route === 'profile' && state.user) {
      const result = await apiClient.trust(state.user.id);
      state.trustProfile = result.profile;
    }
    if (state.route === 'admin' && state.user?.isAdmin) {
      const result = await apiClient.adminOverview();
      state.adminOverview = result.overview;
    }
  } catch (error) {
    if (error instanceof ApiError && [401, 403].includes(error.status)) {
      state.user = null;
      state.activity = null;
      state.trustProfile = null;
    } else {
      state.routeError = error;
    }
  }
}

function activityFingerprint(activity) {
  const owned = (activity?.ownedChallenges || []).map((item) => [item.id, item.status, item.fundingStatus, item.teaserCount, item.participantCount, item.updatedAt]);
  const applied = (activity?.applications || []).map((item) => [item.challenge?.id, item.teaserStatus, item.challenge?.status, item.challenge?.fundingStatus, item.challenge?.teaserCount, item.challenge?.updatedAt]);
  const notifications = (activity?.notifications || []).map((item) => [item.id, item.read_at]);
  return JSON.stringify([owned, applied, notifications]);
}

async function refreshDashboardActivity() {
  if (activityPollBusy || state.route !== 'dashboard' || !state.user || document.hidden) return;
  activityPollBusy = true;
  try {
    const next = await apiClient.activity();
    if (activityFingerprint(next) !== activityFingerprint(state.activity)) {
      state.activity = next;
      render();
    }
  } catch {
    // A background refresh must not replace the current dashboard with an error.
  } finally {
    activityPollBusy = false;
  }
}

function syncActivityPolling() {
  if (activityPollTimer) clearInterval(activityPollTimer);
  activityPollTimer = state.route === 'dashboard' && state.user
    ? setInterval(refreshDashboardActivity, 8000)
    : null;
}

function bindGlobalEvents() {
  document.addEventListener('click', async (event) => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) {
      event.preventDefault();
      navigate(routeButton.dataset.route);
      return;
    }
    const policyButton = event.target.closest('[data-policy]');
    if (policyButton) {
      event.preventDefault();
      openPolicy(policyButton.dataset.policy);
      return;
    }

    const actionButton = event.target.closest('[data-action]');
    if (actionButton) {
      event.preventDefault();
      await handleAction(actionButton.dataset.action, actionButton.dataset, actionButton);
      return;
    }

    const challengeButton = event.target.closest('button[data-challenge-id], .challenge-card[data-challenge-id]');
    if (challengeButton) {
      event.preventDefault();
      await openChallenge(challengeButton.dataset.challengeId);
      return;
    }

    const categoryButton = event.target.closest('[data-category]');
    if (categoryButton) {
      state.category = categoryButton.dataset.category;
      if (state.route !== 'explore') navigate('explore');
      else render();
      return;
    }

    if (event.target.classList.contains('modal-backdrop')) closeModal();
  });

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    event.preventDefault();
    await handleForm(form);
  });
  document.addEventListener('invalid', (event) => {
    const field = event.target;
    const form = field?.form;
    if (!(form instanceof HTMLFormElement) || !['signup-form', 'oauth-signup-form'].includes(form.id)) return;
    const label = field.closest('.field, .check-row')?.querySelector('label')?.textContent?.replace('*', '').trim() || field.getAttribute('aria-label') || '필수 항목';
    field.setCustomValidity('');
    const message = field.validity.valueMissing ? `${label}을(를) 입력하거나 선택해주세요.`
      : field.validity.typeMismatch ? '이메일 형식을 정확히 입력해주세요.'
      : field.validity.tooShort ? `${label}은(는) 최소 ${field.minLength}자 이상 입력해주세요.`
      : '입력 형식을 확인해주세요.';
    field.setCustomValidity(message);
    setTimeout(() => field.setCustomValidity(''), 0);
    toast('회원가입 정보를 확인해주세요', message, 'warning');
  }, true);

  document.addEventListener('input', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-birth-year-digit]')) {
      event.target.value = event.target.value.replace(/\D/g, '').slice(-1);
      if (event.target.value) {
        const digits = [...event.target.form.querySelectorAll('[data-birth-year-digit]')];
        const next = digits[digits.indexOf(event.target) + 1];
        next?.focus();
      }
    }
    if (event.target.id === 'explore-search') {
      state.search = event.target.value;
      renderExploreGridOnly();
    }
    if (event.target.closest?.('#challenge-create-form')) {
      saveCreateDraft();
      updateCreatePreview();
    }
    if (event.target.closest?.('#teaser-form, #cancel-form')) saveTransientModalDraft(event.target.form);
    clearFieldError(event.target);
    updateFieldCounter(event.target);
  });

  document.addEventListener('change', (event) => {
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-signup-consent-all]')) {
      const form = event.target.form;
      form?.querySelectorAll('[data-signup-consent-item]').forEach((item) => {
        if (item instanceof HTMLInputElement) item.checked = event.target.checked;
      });
    }
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-signup-consent-item]')) {
      const form = event.target.form;
      const all = form?.querySelector('[data-signup-consent-all]');
      const items = [...(form?.querySelectorAll('[data-signup-consent-item]') || [])].filter((item) => item instanceof HTMLInputElement);
      if (all instanceof HTMLInputElement) {
        all.checked = items.length > 0 && items.every((item) => item.checked);
        all.indeterminate = !all.checked && items.some((item) => item.checked);
      }
    }
    if (event.target.id === 'explore-sort') {
      state.sort = event.target.value;
      renderExploreGridOnly();
    }
    if (event.target.closest?.('.criteria-check-builder')) updateCriteriaFromChecks();
    if (event.target.closest?.('#challenge-create-form')) updateCreatePreview();
  });

  document.querySelector('#account-button')?.addEventListener('click', () => {
    if (state.user) openAccountMenu(); else openAuthModal('login');
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
    if (event.target instanceof HTMLInputElement && event.target.matches('[data-birth-year-digit]') && event.key === 'Backspace' && !event.target.value) {
      const digits = [...event.target.form.querySelectorAll('[data-birth-year-digit]')];
      digits[digits.indexOf(event.target) - 1]?.focus();
    }
    const challengeCard = event.target.closest?.('.challenge-card[data-challenge-id]');
    if (challengeCard && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault();
      openChallenge(challengeCard.dataset.challengeId);
    }
  });
}

async function handleAction(action, data, button) {
  try {
    if (action === 'close-modal') return await closeModal();
    if (action === 'new-simulation') return requireLogin(openSimulationCreate);
    if (action === 'start-simulation') return await withBusy(button, async () => {
      button.dataset.requestId ||= crypto.randomUUID();
      await createSimulation({challengeId:data.challengeId},button.dataset.requestId);
    });
    if (action === 'simulation-role') { state.simulationRole=data.role==='solver'?'solver':'owner';render();return; }
    if (action === 'load-simulation') return navigate(`simulation?id=${encodeURIComponent(data.simulationId)}`);
    if (action === 'simulation-step') return await withBusy(button,()=>runSimulationAction(data.step,{candidateId:data.candidateId},button));
    if (action === 'login') return await openAuthModal('login');
    if (action === 'signup') return await openAuthModal('signup');
    if (action === 'oauth-login') return await startSocialLogin(data.provider);
    if (action === 'confirm-oauth-login') return await startSocialLogin(data.provider);
    if (action === 'select-create-example') return await selectCreateExample(data.example, button);
    if (action === 'install-web-app') return await installWebApp();
    if (action === 'dismiss-web-app-install') return await dismissWebAppInstall();
    if (action === 'logout') return await logout();
    if (action === 'retry') return location.reload();
    if (action === 'open-demo') return location.assign('/demo.html');
    if (action === 'preview-home-theme') {
      if (state.user?.adminRole !== 'primary') return;
      state.previewHomeTheme = HOME_THEME_OPTIONS.some((item) => item.id === data.theme) ? data.theme : null;
      return navigate('home');
    }
    if (action === 'return-theme-settings') { state.previewHomeTheme = null; return navigate('admin'); }
    if (action === 'apply-home-theme') return await withBusy(button, () => applyHomeTheme(data.theme));
    if (action === 'submit-teaser') return await requireLogin(() => openTeaserForm(data.challengeId));
    if (action === 'view-my-teaser' || action === 'retry-my-teaser') return await requireLogin(() => openMyTeaser(data.challengeId));
    if (action === 'view-challenge-content') return await openChallengeContent(data.challengeId);
    if (action === 'view-progress') return await openChallenge(data.challengeId);
    if (action === 'view-applied-challenges') return await openActivitySection('applied');
    if (action === 'edit-teaser') return await requireLogin(() => openTeaserEditForm(data.challengeId));
    if (action === 'withdraw-teaser') return await requireLogin(() => openTeaserWithdrawForm(data.challengeId));
    if (action === 'fill-teaser-template') return await fillTeaserTemplate(data.challengeId);
    if (action === 'review-candidates') return await requireLogin(() => openCandidateReview(data.challengeId));
    if (action === 'shortlist') return await withBusy(button, () => shortlistCandidate(data.challengeId, data.teaserId, 'shortlist'));
    if (action === 'select-finalist') return await withBusy(button, () => shortlistCandidate(data.challengeId, data.teaserId, 'select'));
    if (action === 'fund-challenge') return await requireLogin(() => openFundingModal(data.challengeId));
    if (action === 'confirm-staging-funding') return await withBusy(button, () => confirmStagingFunding(data.challengeId));
    if (action === 'submit-proof') return await requireLogin(() => openProofForm(data.challengeId));
    if (action === 'confirm-success') return await requireLogin(() => openSuccessConfirm(data.challengeId));
    if (action === 'do-confirm-success') return await withBusy(button, () => confirmSuccess(data.challengeId));
    if (action === 'view-settlement') return await openSettlement(data.challengeId);
    if (action === 'write-review') return await requireLogin(() => openReviewForm(data.challengeId));
    if (action === 'share-challenge') return await shareChallenge(data.challengeId);
    if (action === 'view-public-profile') return await openPublicProfile(data.userId);
    if (action === 'view-admin-member') return await openAdminMemberDetail(data.userId);
    if (action === 'open-member-status') return openAdminMemberStatus(data.userId, data.currentStatus);
    if (action === 'open-admin-dispute') return await openAdminDispute(data.disputeId);
    if (action === 'view-trust-history') return await openTrustHistory(data.userId);
    if (action === 'open-notification') return await openNotification(data.notificationId, data.challengeId);
    if (action === 'change-password') return await openChangePassword();
    if (action === 'enable-push') return await withBusy(button, () => enablePushNotifications(button));
    if (action === 'disable-push') return await disablePushNotifications();
    if (action === 'open-push-announcement') return await openPushAnnouncement();
    if (action === 'add-moderation-note') return await openModerationNote(data.challengeId);
    if (action === 'password-help') return await openLoginHelp();
    if (action === 'find-email') return await openEmailFinder();
    if (action === 'request-password-reset') return await openPasswordResetRequest();
    if (action === 'open-primary-recovery') return await openPrimaryRecovery();
    if (action === 'retry-challenge-detail') return await openChallenge(data.challengeId);
    if (action === 'retry-candidate-review') return await openCandidateReview(data.challengeId);
    if (action === 'retry-current-route') return await refreshCurrentRoute();
    if (action === 'view-owned-challenges') return await openOwnedChallenges();
    if (action === 'view-trust-guide') return await openTrustGuide();
    if (action === 'entity-cases') return await openEntityCases(false);
    if (action === 'admin-entity-cases') return await openEntityCases(true);
    if (action.startsWith('entity-')) return await withBusy(button,()=>entityAction(button));
    if (action === 'admin-verifications') return await openAdminVerifications();
    if (action === 'review-verification') return openVerificationReview(button.dataset.verificationId);
    if (action === 'manage-verifications') return await openVerificationManager();
    if (action === 'request-verification') return await withBusy(button, () => requestVerification(button.dataset.verificationType, button.dataset.subjectType));
    if (action === 'create-mode') { saveCreateDraft(); state.createMode = data.mode === 'direct' ? 'direct' : 'easy'; render(); restoreCreateDraft(); return; }
    if (action === 'generate-challenge-draft') return await generateChallengeDraft(button);
    if (action === 'cancel-challenge') return await requireLogin(() => openCancelForm(data.challengeId));
    if (action === 'edit-challenge') return await requireLogin(() => openChallengeEditForm(data.challengeId));
    if (action === 'open-dispute') return await requireLogin(() => openDisputeForm(data.challengeId));
    if (action === 'open-admin') { closeModal(); return await navigate('admin'); }
    if (action === 'approve-moderation') return await withBusy(button, () => approveModerationChallenge(data.challengeId));
    if (action === 'auto-review-moderation') return await withBusy(button, () => autoReviewModerationQueue());
    if (action === 'archive-moderation') return await openModerationArchive(data.challengeId);
    if (action === 'appeal-moderation') return await openModerationAppeal(data.challengeId);
    if (action === 'appoint-deputy') return await withBusy(button, () => updateDeputy(data.userId, true));
    if (action === 'revoke-deputy') return await withBusy(button, () => updateDeputy(data.userId, false));
  } catch (error) {
    showError(error);
  }
}

async function handleForm(form) {
  const submit = form.querySelector('[type="submit"]');
  try {
    if (form.id.startsWith('entity-')) return await withBusy(submit,()=>entityForm(form));
    if (form.id === 'login-form') return await withBusy(submit, () => submitLogin(form));
    if (['signup-form', 'oauth-signup-form'].includes(form.id)) return await withBusy(submit, () => submitSignup(form));
    if (form.id === 'identity-start-form') return await withBusy(submit, () => startIdentityVerification(form));
    if (form.id === 'verification-review-form') return await withBusy(submit, () => submitVerificationReview(form));
    if (form.id === 'resend-verification-form') return await withBusy(submit, () => submitResendVerification(form));
    if (form.id === 'email-find-form') return await withBusy(submit, () => submitEmailFinder(form));
    if (form.id === 'password-reset-request-form') return await withBusy(submit, () => submitPasswordResetRequest(form));
    if (form.id === 'password-reset-form') return await withBusy(submit, () => submitPasswordReset(form));
    if (form.id === 'simulation-create-form') return await withBusy(submit,()=>submitSimulationCreate(form));
    if (form.id === 'simulation-proof-form') return await withBusy(submit,()=>runSimulationAction('SUBMIT_PROOF',{proof:new FormData(form).get('proof')},form));
    if (form.id === 'challenge-create-form') return await withBusy(submit, () => submitChallenge(form));
    if (form.id === 'challenge-edit-form') return await withBusy(submit, () => submitChallengeEdit(form));
    if (form.id === 'teaser-form') return await withBusy(submit, () => submitTeaser(form));
    if (form.id === 'teaser-edit-form') return await withBusy(submit, () => submitTeaserEdit(form));
    if (form.id === 'teaser-withdraw-form') return await withBusy(submit, () => submitTeaserWithdraw(form));
    if (form.id === 'proof-form') return await withBusy(submit, () => submitProof(form));
    if (form.id === 'review-form') return await withBusy(submit, () => submitReview(form));
    if (form.id === 'cancel-form') return await withBusy(submit, () => submitCancel(form));
    if (form.id === 'dispute-form') return await withBusy(submit, () => submitDispute(form));
    if (form.id === 'change-password-form') return await withBusy(submit, () => submitPasswordChange(form));
    if (form.id === 'primary-recovery-form') return await withBusy(submit, () => submitPrimaryRecovery(form));
    if (form.id === 'moderation-note-form') return await withBusy(submit, () => submitModerationNote(form));
    if (form.id === 'moderation-archive-form') return await withBusy(submit, () => submitModerationArchive(form));
    if (form.id === 'moderation-appeal-form') return await withBusy(submit, () => submitModerationAppeal(form));
    if (form.id === 'push-announcement-form') return await withBusy(submit, () => submitPushAnnouncement(form));
    if (form.id === 'admin-member-status-form') return await withBusy(submit, () => submitAdminMemberStatus(form));
    if (form.id === 'admin-dispute-status-form') return await withBusy(submit, () => submitAdminDisputeStatus(form));
    if (form.id === 'hero-search-form') {
      state.search = new FormData(form).get('q')?.toString() || '';
      navigate('explore');
    }
  } catch (error) {
    if (['signup-form', 'oauth-signup-form'].includes(form.id) && error instanceof ApiError) return showSignupFieldError(form, error);
    if (form.id === 'login-form' && error instanceof ApiError && error.code === 'EMAIL_UNVERIFIED') {
      const email = String(new FormData(form).get('email') || '');
      openModal(`<form id="resend-verification-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">✉</span><h2>이메일 인증 필요</h2><p>가입 이메일로 인증 링크를 다시 보낼 수 있습니다.</p></div><input name="email" type="hidden" value="${escapeAttribute(email)}" /><button class="btn btn-primary btn-block" type="submit">인증메일 다시 보내기</button></form>`, { title: '이메일 확인' });
      return;
    }
    if (form.id === 'primary-recovery-form') {
      const feedback = form.querySelector('[data-recovery-status]');
      if (feedback) {
        feedback.hidden = false;
        feedback.className = 'form-feedback error';
        feedback.textContent = error instanceof ApiError ? error.message : '계정 복구를 완료하지 못했습니다. 입력값을 다시 확인해주세요.';
      }
    }
    if (!['signup-form', 'oauth-signup-form'].includes(form.id)) {
      let feedback = form.querySelector('.submit-error');
      if (!feedback) { feedback = document.createElement('p'); feedback.className = 'submit-error field-error'; feedback.setAttribute('role', 'alert'); submit?.before(feedback); }
      feedback.textContent = error instanceof ApiError ? error.message : '요청을 처리하지 못했습니다. 입력 내용은 유지됩니다. 다시 시도해주세요.';
    }
    showError(error);
  }
}

async function submitModerationNote(form) {
  const data = new FormData(form);
  await apiClient.addModerationNote(form.dataset.challengeId, String(data.get('note') || ''), data.get('requestApproval') === 'on');
  closeModal();
  await refreshCurrentRoute();
  toast('검토 의견을 저장했습니다', data.get('requestApproval') === 'on' ? '최고관리자에게 승인 검토가 요청되었습니다.' : '최고관리자가 검토할 수 있습니다.', 'success');
}

function openPushAnnouncement() {
  if (state.user?.adminRole !== 'primary') return toast('최고관리자 전용 기능입니다', '공지 푸시는 최고관리자만 발송할 수 있습니다.', 'warning');
  openModal(`<form id="push-announcement-form" class="auth-form"><div class="notice-box"><span>◉</span><div><strong>전체 공지 푸시</strong><p>푸시알림을 직접 켠 활성 회원에게만 발송됩니다. 현재 로그인한 최고관리자도 푸시를 켠 경우 수신 대상에 포함됩니다. 개인정보·연락처·개별 미션 상세는 입력하지 마세요.</p></div></div><div class="field"><label>알림 제목</label><input name="title" minlength="2" maxlength="60" required placeholder="예: 새로운 이용 안내" /></div><div class="field"><label>알림 내용</label><textarea name="body" minlength="2" maxlength="120" rows="4" required placeholder="예: 앱에서 새로운 안내를 확인해주세요."></textarea></div><label class="check-row"><input name="confirmSend" type="checkbox" required /><span>발송 대상과 내용을 확인했습니다. 이 작업은 발송 기록에 남습니다.</span></label><button class="btn btn-primary btn-lg btn-block" type="submit">공지 푸시 발송</button></form>`, { title: '공지 푸시 발송' });
}

async function submitPushAnnouncement(form) {
  if (state.user?.adminRole !== 'primary') throw new ApiError('최고관리자만 공지 푸시를 발송할 수 있습니다.', { code: 'PRIMARY_ADMIN_REQUIRED' });
  const data = new FormData(form);
  const title = String(data.get('title') || '');
  const body = String(data.get('body') || '');
  if (!window.confirm(`푸시알림을 켠 회원에게 다음 내용을 발송할까요?\n\n${title}\n${body}`)) return;
  const result = await apiClient.sendPushAnnouncement({ title, body, confirmSend: data.get('confirmSend') === 'on' });
  closeModal();
  const item = result.announcement;
  toast('공지 푸시 발송을 요청했습니다', `대상 ${item.eligibleCount}명 · 전달 ${item.deliveredCount}명${item.administratorIncluded ? ' · 관리자 수신 포함' : ''}`, 'success');
}

function render() {
  if (state.loading) return;
  document.body.dataset.homeTheme = state.previewHomeTheme && state.user?.adminRole === 'primary'
    ? state.previewHomeTheme : (state.config?.homeTheme || 'original');
  if (heroRotationTimer) {
    clearInterval(heroRotationTimer);
    heroRotationTimer = null;
  }
  renderHeader();
  markActiveNavigation();
  if (state.route === 'home') main.innerHTML = renderHome();
  else if (state.route === 'explore') main.innerHTML = renderExplore();
  else if (state.route === 'how') main.innerHTML = renderHow();
  else if (state.route === 'trust') main.innerHTML = renderTrustSafety();
  else if (state.route === 'create') main.innerHTML = renderCreate();
  else if (state.route === 'dashboard') main.innerHTML = renderDashboard();
  else if (state.route === 'simulation') main.innerHTML = renderSimulation();
  else if (state.route === 'profile') main.innerHTML = renderProfile();
  else if (state.route === 'verify-email') main.innerHTML = renderEmailVerification();
  else if (state.route === 'reset-password') main.innerHTML = renderPasswordReset();
  else if (['login', 'signup', 'social-signup'].includes(state.route)) main.innerHTML = renderHome();
  else if (state.route === 'admin') main.innerHTML = renderAdmin();
  else main.innerHTML = renderNotFound();
  if (state.previewHomeTheme && state.user?.adminRole === 'primary') {
    main.insertAdjacentHTML('afterbegin', `<div class="home-theme-preview-bar"><strong>${escapeHTML(HOME_THEME_OPTIONS.find((item) => item.id === state.previewHomeTheme)?.title || '')} 전체 화면 미리보기</strong><span>방문자에게는 아직 적용되지 않았습니다. 메뉴를 눌러 세부 화면도 확인하세요.</span><button class="btn btn-outline btn-small" type="button" data-action="return-theme-settings">관리자로 돌아가기</button></div>`);
  }
  hydratePage();
  focusActivitySection();
  updateWebAppInstallBanner();
  syncActivityPolling();
}

function bindWebAppInstall() {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    updateWebAppInstallBanner();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    sessionStorage.setItem('modu-web-app-installed', '1');
    updateWebAppInstallBanner();
  });
}

function isStandaloneWebApp() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

function isIOSSafari() {
  const userAgent = navigator.userAgent || '';
  return /iPad|iPhone|iPod/.test(userAgent) && !/CriOS|FxiOS|EdgiOS/.test(userAgent);
}

function isSamsungInternet() {
  return /SamsungBrowser/i.test(navigator.userAgent || '');
}

function updateWebAppInstallBanner() {
  const banner = document.querySelector('#app-install-banner');
  if (!banner) return;
  const dismissed = sessionStorage.getItem('modu-web-app-install-dismissed') === '1';
  const installed = sessionStorage.getItem('modu-web-app-installed') === '1' || isStandaloneWebApp();
  const showIOSGuide = isIOSSafari() && !installed;
  const showSamsungGuide = isSamsungInternet() && !installed;
  banner.hidden = state.route === 'admin' || dismissed || installed || (!deferredInstallPrompt && !showIOSGuide && !showSamsungGuide && !/Chrome|Chromium|Edg\//.test(navigator.userAgent));
  if (banner.hidden) return;
  const title = banner.querySelector('#app-install-title');
  const copy = banner.querySelector('#app-install-copy');
  const action = banner.querySelector('#app-install-action');
  if (showIOSGuide) {
    title.textContent = '아이폰 홈 화면에 추가';
    copy.textContent = '하단 공유 버튼 → 홈 화면에 추가를 누르면 앱처럼 열립니다.';
    action.hidden = true;
  } else if (showSamsungGuide && !deferredInstallPrompt) {
    title.textContent = 'Galaxy에서 앱처럼 열기';
    copy.textContent = 'Chrome으로 연 뒤 ⋮ 메뉴에서 “앱 설치” 또는 “홈 화면에 추가”를 선택하세요.';
    action.hidden = true;
  } else {
    title.textContent = '모두의클리어 앱';
    copy.textContent = '홈 화면에 설치하고 주소창 없이 바로 열어보세요.';
    action.hidden = false;
    action.textContent = deferredInstallPrompt ? '설치' : '설치 안내';
  }
}

async function installWebApp() {
  if (!deferredInstallPrompt) {
    const edge = /Edg\//.test(navigator.userAgent);
    openModal(`<div class="notice-box"><div><strong>브라우저에서 앱 설치하기</strong><p>${edge ? 'Edge의 ⋯ 메뉴 → 앱 → 이 사이트를 앱으로 설치' : 'Chrome의 ⋮ 메뉴 → 전송, 저장, 공유 → 페이지를 앱으로 설치'}</p><p>설치 메뉴가 없으면 브라우저 업데이트와 기존 설치 여부를 확인해주세요.</p></div></div>`, { title: '앱 설치 안내' });
    return;
  }
  const prompt = deferredInstallPrompt;
  deferredInstallPrompt = null;
  await prompt.prompt();
  await prompt.userChoice;
  updateWebAppInstallBanner();
}

function dismissWebAppInstall() {
  sessionStorage.setItem('modu-web-app-install-dismissed', '1');
  updateWebAppInstallBanner();
}

function renderHeader() {
  const avatar = document.querySelector('#header-avatar');
  const name = document.querySelector('#header-user-name');
  const role = document.querySelector('#header-user-role');
  if (!avatar || !name || !role) return;
  if (!state.user) {
    avatar.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="3.25"></circle><path d="M5.5 20c.75-3.35 3.12-5.2 6.5-5.2S17.75 16.65 18.5 20"></path></svg>';
    avatar.className = 'avatar avatar-sm avatar-guest';
    avatar.setAttribute('aria-label', '로그인 및 계정 시작');
    name.textContent = '로그인';
    role.textContent = '계정 시작하기';
    return;
  }
  avatar.textContent = initial(state.user.displayName);
  avatar.className = `avatar avatar-sm ${state.user.isAdmin ? 'avatar-admin' : state.user.accountType !== 'individual' ? 'avatar-company' : ''}`;
  avatar.removeAttribute('aria-label');
  name.textContent = state.user.displayName;
  role.textContent = state.user.adminRole === 'primary' ? '최고관리자' : state.user.adminRole === 'deputy' ? '부관리자' : `TRUST ${state.user.trustScore}`;
}

function renderSystemNotice() {
  if (!notice) return;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const error = params.get('oauth_error');
  if (error) {
    notice.hidden = false;
    document.querySelector('#system-notice-title').textContent = '소셜 로그인 확인 필요';
    document.querySelector('#system-notice-body').textContent = error;
  } else if (params.get('oauth') === 'success' && state.user) {
    notice.hidden = false;
    document.querySelector('#system-notice-title').textContent = '소셜 로그인 완료';
    document.querySelector('#system-notice-body').textContent = '로그인 상태를 안전하게 확인했습니다.';
  } else if (params.get('oauth') === 'success') {
    notice.hidden = false;
    document.querySelector('#system-notice-title').textContent = '로그인 상태 확인 필요';
    document.querySelector('#system-notice-body').textContent = '소셜 계정 확인 후 로그인 상태를 유지하지 못했습니다. 쿠키를 허용하고 같은 브라우저에서 다시 로그인해주세요.';
  } else notice.hidden = true;
}

function markActiveNavigation() {
  document.querySelectorAll('[data-route]').forEach((element) => {
    element.classList.toggle('active', element.dataset.route === state.route);
  });
}

function renderHome() {
  const featured = sortChallenges([...state.challenges], 'popular').slice(0, 6);
  const rankedLive = sortChallenges(state.challenges.filter((challenge) => !['FAILED', 'CANCELLED'].includes(challenge.status)), 'reward');
  const liveStartIndex = rankedLive.length ? Number(sessionStorage.getItem('modu-live-rank-index') || 0) % rankedLive.length : 0;
  if (rankedLive.length) sessionStorage.setItem('modu-live-rank-index', String((liveStartIndex + 1) % rankedLive.length));
  const active = state.challenges.filter((challenge) => !['SUCCESS', 'FAILED', 'CANCELLED'].includes(challenge.status)).length;
  const totalReward = state.challenges.reduce((sum, challenge) => sum + challenge.rewardAmount, 0);
  const success = state.challenges.filter((challenge) => challenge.status === 'SUCCESS').length;
  const totalTeasers = state.challenges.reduce((sum, challenge) => sum + Number(challenge.teaserCount || 0), 0);
  const totalParticipants = state.challenges.reduce((sum, challenge) => sum + Number(challenge.participantCount || 0), 0);
  const progressed = state.challenges.filter((challenge) => ['SHORTLISTED', 'SUCCESS'].includes(challenge.status)).length;
  const impactChallenges = state.challenges.filter((challenge) => ['LOCAL', 'SOCIAL', 'PUBLIC'].includes(challenge.category)).length;
  const completedReward = state.challenges.filter((challenge) => challenge.status === 'SUCCESS').reduce((sum, challenge) => sum + challenge.rewardAmount, 0);
  const solverPayout = Math.round(completedReward * (1 - Number(state.config?.feeRate || 0.1)));
  const rewardedPeople = new Set(state.challenges.filter((challenge) => challenge.status === 'SUCCESS' && challenge.selectedSolverId).map((challenge) => challenge.selectedSolverId)).size;
  const estimatedHoursSaved = totalTeasers * 2;
  const estimatedSearchCostSaved = estimatedHoursSaved * 20_000;
  const homeTheme = state.previewHomeTheme && state.user?.adminRole === 'primary' ? state.previewHomeTheme : state.config?.homeTheme;
  const studioTheme = ['luxury', 'community', 'command', 'magazine', 'journey'].includes(homeTheme);
  return `
    ${studioTheme ? renderStudioHome(homeTheme) : `<section class="hero">
      <div class="container hero-grid">
        <div class="hero-copy">
          <span class="hero-badge"><i></i> 재능·경험·인맥이 새로운 기회가 됩니다</span>
          <h1>미션을 올리고, <br><em>해결하고, 보상받다.</em></h1>
          <p class="hero-lead">재능·경험·인맥으로 문제를 해결하고 보상을 받아보세요.</p>
          <div class="hero-actions">
            <button class="btn btn-primary btn-lg" type="button" data-route="create">미션 등록</button>
            <button class="btn btn-outline btn-lg" type="button" data-route="explore">미션 찾기</button>
          </div>
          <form class="hero-search" id="hero-search-form">
            <input name="q" aria-label="미션 검색" placeholder="내가 해결할 수 있는 미션을 찾아보세요" />
            <button class="btn btn-primary" type="submit">검색</button>
          </form>
        </div>
        <div class="hero-visual">
          <div class="hero-photo-frame">
            <img src="/assets/modu-young-challengers.webp" alt="젊은 전문가들이 함께 미션을 기획하고 게시하는 모습" width="1600" height="1024" fetchpriority="high" />
            <div class="hero-photo-caption"><span><i></i> ACTIVE COMMUNITY</span><strong>함께 찾고, 제안하고, 실행합니다</strong></div>
          </div>
          <div class="hero-board">
            <div class="hero-board-head"><strong>현재 공개 미션</strong><span class="live-pill"><i></i><span>LIVE</span></span></div>
            ${rankedLive[liveStartIndex] ? renderHeroChallenge(rankedLive[liveStartIndex], true) : renderEmpty('첫 미션을 기다리고 있습니다', '해결하고 싶은 일을 가장 먼저 등록해보세요.')}
          </div>
        </div>
      </div>
    </section>`}

    <section class="impact-showcase" aria-labelledby="impact-title"><div class="container">
      <div class="impact-shell">
        <div class="impact-orbit impact-orbit-one"></div><div class="impact-orbit impact-orbit-two"></div>
        <div class="impact-heading">
          <div><span class="impact-kicker"><i></i> 함께 만든 기회</span><h2 id="impact-title">하나의 미션에서,<br><em>새로운 해결의 기회가 시작됩니다.</em></h2></div>
          <div class="impact-preview-badge"><strong>LIVE PREVIEW</strong><span>예시 데이터 기반</span></div>
        </div>
        <div class="impact-counter-grid">
          ${renderImpactCounter('공개 미션', state.challenges.length, 'number', '누적 공개 미션', `${active.toLocaleString('ko-KR')}건 진행 중`, '✦')}
          ${renderImpactCounter('SOLUTION SIGNALS', totalTeasers, 'number', '누적 TEASER', `${totalParticipants.toLocaleString('ko-KR')}명 참여·관심 신호`, '◉')}
          ${renderImpactCounter('OPEN REWARD POOL', totalReward, 'won', '공개 문제해결 예산', '도전자에게 열린 보상 기회', '₩')}
          ${renderImpactCounter('SUCCESS', success, 'number', '완료된 성과 사례', `${rewardedPeople.toLocaleString('ko-KR')}명 예시 보상 수령자`, '✓')}
          ${renderImpactCounter('SOLVER PAYOUT', solverPayout, 'won', '성공자 예상 순보상', '플랫폼 수수료 10% 차감 기준', '↗')}
          ${renderImpactCounter('TIME SAVED', estimatedHoursSaved, 'hours', '예상 탐색시간 절감', `탐색비용 약 ${formatCompactWon(estimatedSearchCostSaved)} 절감`, '◷')}
        </div>
        <div class="impact-funnel" aria-label="미션 성과 흐름">
          <div><span>공개</span><strong>${state.challenges.length.toLocaleString('ko-KR')} 미션</strong></div><i>→</i>
          <div><span>해결 신호</span><strong>${totalTeasers.toLocaleString('ko-KR')} TEASER</strong></div><i>→</i>
          <div><span>후보·성과 진입</span><strong>${progressed.toLocaleString('ko-KR')}건</strong></div><i>→</i>
          <div><span>클리어 완료</span><strong>${success.toLocaleString('ko-KR')}건</strong></div>
        </div>
        <div class="impact-footnote"><span>지역·사회·공공 임팩트 미션 <strong>${impactChallenges.toLocaleString('ko-KR')}건</strong></span><p>미리보기 추정치: TEASER 1건당 사전 탐색 2시간, 시간가치 2만원 적용. 실제 운영 실적·지급액이 아니며 운영 데이터 축적 후 검증값으로 전환됩니다.</p></div>
      </div>
    </div></section>

    <section class="page-section"><div class="container">
      <div class="section-head"><div><span class="eyebrow">미션 마켓</span><h2>지금 살펴볼 수 있는 미션</h2><p>능력·정보·아이디어·인맥·실행력으로 결과를 만들어보세요.</p></div><button class="btn btn-outline" type="button" data-route="explore">전체 보기</button></div>
      ${featured.length ? `<div class="challenge-grid">${featured.map(renderChallengeCard).join('')}</div>` : renderEmpty('공개된 미션이 없습니다', '첫 미션을 만들어 시장을 시작해보세요.', '<button class="btn btn-primary" data-route="create">미션 등록</button>')}
    </div></section>

    <section class="page-section section-soft" id="how-section"><div class="container">
      <div class="section-head centered"><div><span class="eyebrow">HOW IT WORKS</span><h2>가능성을 먼저 보고, 선택한 뒤 진행합니다</h2></div></div>
      <div class="step-grid">
        ${renderStep('01', '미션 등록', '필요한 일과 완료 기준, 보상금 또는 포상금을 등록합니다.')}
        ${renderStep('02', '도전하기', '재능·기술·경험·정보·인맥·시간·실행력을 담은 티저로 제안합니다.')}
        ${renderStep('03', '해결자 선택', '의뢰자가 제안과 신뢰 이력을 비교해 해결자를 선택합니다.')}
        ${renderStep('04', '해결·결과 제출', '보상금 확보 후 미션을 수행하고 결과와 증빙을 제출합니다.')}
        ${renderStep('05', '검수·클리어', '의뢰자가 결과를 검수하고 완료를 확정하면 보상 지급과 리뷰로 이어집니다.')}
      </div>
    </div></section>

    <section class="page-section" id="trust-section"><div class="container trust-section-grid">
      <div><span class="eyebrow">TRUST BY ACTION</span><h2>말보다 실제 이행기록으로 신뢰를 만듭니다</h2><p class="section-description">의뢰자의 Funding 이행, 도전자의 수행완료, 상호리뷰, 분쟁 귀책과 Strike가 역할별 TRUST 이력에 반영됩니다.</p><button class="btn btn-primary" type="button" data-route="profile">보상 확인</button></div>
      <div class="trust-feature-grid">
        ${renderTrustFeature('✓', '양방향 평가', '의뢰자와 도전자가 서로의 정확성·응답·이행을 평가합니다.')}
        ${renderTrustFeature('₩', '지급 이력', '실제 Funding·지급 완료 횟수와 누적액을 분리해 보여줍니다.')}
        ${renderTrustFeature('3', '3-Strike', '일반 미이행은 단계적으로 제한하고 중대한 사기는 즉시 차단합니다.')}
        ${renderTrustFeature('▤', '자격 검증', '본인·사업자·전문자격 배지는 TRUST 점수와 별도로 표시합니다.')}
      </div>
    </div></section>
  `;
}

function renderStudioMission(challenge, index = 0) {
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.BUSINESS;
  const title = escapeHTML(challenge.title);
  const reward = formatWon(challenge.rewardAmount);
  return `<button class="studio-mission" type="button" data-challenge-id="${escapeAttribute(challenge.id)}">
    <span class="studio-mission-top"><b>${String(index + 1).padStart(2, '0')}</b><span class="studio-mission-category"><span class="studio-mission-icon">${category.icon}</span><span>${escapeHTML(category.label)}${challenge.isExample ? ' · 예시 미션' : ''}</span></span></span>
    <strong>${title}</strong><span class="studio-mission-summary">${escapeHTML(challenge.summary)}</span>
    <span class="studio-mission-reward"><small>${challenge.isExample ? '예시 제시금' : '제시 보상금'}</small><b>${reward}</b><i aria-hidden="true">↗</i></span>
  </button>`;
}

function renderStudioHome(theme) {
  const open = sortChallenges(state.challenges.filter((item) => item.status === 'OPEN' && !item.moderationPending && daysLeft(item.deadline) >= 0), 'reward');
  const missions = [];
  const seenTitles = new Set();
  const seenCategories = new Set();
  for (const item of open) {
    const key = item.title.replace(/^\[예시\]\s*/, '').trim();
    if (seenTitles.has(key) || seenCategories.has(item.category)) continue;
    missions.push(item); seenTitles.add(key); seenCategories.add(item.category);
    if (missions.length === 6) break;
  }
  for (const item of open) {
    const key = item.title.replace(/^\[예시\]\s*/, '').trim();
    if (missions.length === 6) break;
    if (!seenTitles.has(key)) { missions.push(item); seenTitles.add(key); }
  }
  const lead = missions[0];
  const reward = lead ? formatWon(lead.rewardAmount) : '';
  const summary = `<p class="studio-truth">예시 미션의 금액은 실제 상금이나 지급 실적이 아닙니다. 현재 실제 결제·지급은 차단되어 있습니다.</p>`;
  const search = `<form class="studio-search" id="hero-search-form"><input name="q" aria-label="미션 검색" placeholder="내가 해결할 수 있는 미션을 찾아보세요"><button type="submit">미션 찾기 →</button></form>`;
  const actions = `<div class="studio-actions"><button type="button" class="btn btn-primary btn-lg" data-route="explore">미션 찾기</button><button type="button" class="btn btn-outline btn-lg" data-route="create">미션 등록</button></div>`;
  const studioPhotos = {
    community: ['/assets/studio-community.webp', '밝은 공간에서 함께 미션을 논의하는 사람들'],
    magazine: ['/assets/studio-editorial.webp', '도시를 바라보며 새로운 기회를 생각하는 사람'],
    journey: ['/assets/studio-journey.webp', '서울 옥상에서 함께 미션을 논의하는 사람들'],
  };
  const [photoSrc, photoAlt] = studioPhotos[theme] || ['/assets/modu-young-challengers.webp', '사람들이 함께 미션을 논의하는 모습'];
  const heroPhoto = `<img class="studio-photo" src="${photoSrc}" alt="${photoAlt}" width="${studioPhotos[theme] ? 1672 : 1600}" height="${studioPhotos[theme] ? 941 : 1024}" fetchpriority="high">`;
  const spotlight = lead ? `<button class="studio-spotlight" type="button" data-challenge-id="${escapeAttribute(lead.id)}"><span>${lead.isExample ? '예시 미션' : '공개 미션'} · ${escapeHTML(CATEGORY_META[lead.category]?.label || '미션')}</span><strong>${escapeHTML(lead.title)}</strong><b>${lead.isExample ? '예시 제시금' : '제시 보상금'} ${reward} ↗</b></button>` : '';
  let hero = '';
  if (theme === 'luxury') hero = `<div class="studio-stage studio-luxury"><div class="container studio-luxury-grid"><div class="studio-copy"><span class="studio-kicker">PEOPLE · MISSIONS · OPPORTUNITIES</span><h1>누군가의 문제를,<br><em>우리의 기회로.</em></h1><p>경험과 아이디어를 미션에 연결하세요. 내가 해결할 수 있는 일부터 시작할 수 있습니다.</p>${actions}${summary}</div><div class="studio-visual">${heroPhoto}${spotlight}</div></div></div>`;
  if (theme === 'community') hero = `<div class="studio-stage studio-community"><div class="container"><div class="studio-community-grid"><div class="studio-community-photo">${heroPhoto}${spotlight}</div><div class="studio-copy"><span class="studio-kicker">오늘의 미션 마켓</span><h1>오늘의 미션,<br><em>함께 클리어!</em></h1><p>내가 할 수 있는 일은 생각보다 가까이 있습니다. 관심 있는 미션부터 둘러보세요.</p>${search}${summary}</div><div class="studio-community-bubbles"><span>아이디어로 도전</span><span>경험으로 해결</span><span>새로운 기회 발견</span></div></div></div></div>`;
  if (theme === 'command') hero = `<div class="studio-stage studio-command"><div class="container studio-command-grid"><div class="studio-copy"><span class="studio-kicker">PEOPLE × MISSIONS × SOLUTIONS</span><h1>해결할 사람이<br><em>연결되는 순간.</em></h1><p>공개 미션을 확인하고 내 경험으로 해결 가능한 일에 도전하세요.</p>${actions}${summary}</div><div class="studio-network" aria-label="미션과 사람을 잇는 연결 그래픽"><div class="studio-orbit orbit-one"></div><div class="studio-orbit orbit-two"></div><div class="studio-network-core">M<span>모두의클리어</span></div><span class="studio-node node-one">아이디어</span><span class="studio-node node-two">디자인</span><span class="studio-node node-three">생활·도움</span><span class="studio-node node-four">비즈니스</span></div><div class="studio-live"><span class="studio-kicker">● LIVE · 공개 미션</span>${missions.slice(0, 4).map((item) => `<button type="button" data-challenge-id="${escapeAttribute(item.id)}"><strong>${escapeHTML(item.title)}</strong><span>${item.isExample ? '예시 제시금' : '제시 보상금'} ${formatWon(item.rewardAmount)}</span></button>`).join('') || '<p>첫 미션을 기다리고 있습니다.</p>'}</div></div></div>`;
  if (theme === 'magazine') hero = `<div class="studio-stage studio-magazine"><div class="container studio-magazine-grid"><div class="studio-copy"><span class="studio-kicker">PEOPLE × MISSIONS × A BRIGHTER TOMORROW</span><h1>작은 의뢰가<br><em>큰 변화를 만듭니다.</em></h1><p>누군가에게 필요한 일과 내가 잘하는 일이 만나는 곳. 공개된 미션을 살펴보세요.</p>${search}${summary}</div><div class="studio-magazine-issue"><span>ISSUE No. 01</span><strong>${state.challenges.length.toLocaleString('ko-KR')}</strong><span>공개 미션 · 예시 포함</span></div><div class="studio-magazine-photo">${heroPhoto}</div></div></div>`;
  if (theme === 'journey') hero = `<div class="studio-stage studio-journey"><div class="studio-journey-photo">${heroPhoto}</div><div class="container studio-journey-content"><div class="studio-copy"><span class="studio-kicker">TOGETHER WE CLEAR</span><h1>함께라면,<br><em>못 풀 문제는 없습니다.</em></h1><p>내게 맞는 미션을 발견하고, 내가 가진 경험으로 한 걸음씩 해결해보세요.</p>${actions}${summary}</div></div><div class="studio-journey-track"><div class="container"><strong>MISSION JOURNEY</strong><span>01 · 미션 찾기</span><span>02 · 제안하기</span><span>03 · 함께 해결하기</span><span>04 · 클리어</span></div></div></div>`;
  return `<section class="studio-home studio-${theme}">${hero}<div class="studio-market container"><div class="studio-market-head"><div><span class="studio-kicker">OPEN MISSIONS</span><h2>${theme === 'magazine' ? '공개된 미션' : theme === 'community' ? '내게 맞는 미션 찾기' : '지금 주목할 미션'}</h2><p>분야별 미션의 상세 내용과 참여 조건을 확인하세요. 신규 의뢰·도전은 본인확인 연동 후 가능합니다.</p></div><button class="btn btn-outline" type="button" data-route="explore">전체 미션 보기 →</button></div>${missions.length ? `<div class="studio-mission-grid">${missions.map(renderStudioMission).join('')}</div>` : `<div class="studio-empty">공개 중인 미션이 없습니다. <button class="btn btn-primary" type="button" data-route="create">첫 미션 등록</button></div>`}</div></section>`;
}

function renderImpactCounter(code, value, format, label, sub, icon) {
  return `<article class="impact-counter"><div class="impact-counter-top"><span>${code}</span><i>${icon}</i></div><strong data-impact-counter data-value="${Number(value || 0)}" data-format="${format}" aria-label="${escapeAttribute(label)} ${escapeAttribute(formatImpactCounter(value, format))}">${formatImpactCounter(value, format)}</strong><h3>${label}</h3><p>${sub}</p></article>`;
}

function renderHow() {
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">HOW IT WORKS</span><h1>이용방법</h1><p>문제 등록부터 TEASER, 후보선정, 수행과 정산까지 단계별로 확인하세요.</p></div></section>
    <section class="page-section"><div class="container">
      <div class="section-head centered"><div><span class="eyebrow">미션 해결 과정</span><h2>가능성을 먼저 보고, 선택한 뒤 진행합니다</h2><p>성공조건과 증빙기준을 먼저 공개해 분쟁 가능성을 줄입니다.</p></div></div>
      <div class="step-grid">
        ${renderStep('01', '미션 등록', '필요한 일과 완료 기준, 보상금 또는 포상금을 등록합니다.')}
        ${renderStep('02', '도전하기', '재능·기술·경험·정보·인맥·시간·실행력을 담은 티저로 제안합니다.')}
        ${renderStep('03', '해결자 선택', '의뢰자가 제안과 신뢰 이력을 비교해 해결자를 선택합니다.')}
        ${renderStep('04', '해결·결과 제출', '보상금 확보 후 미션을 수행하고 결과와 증빙을 제출합니다.')}
        ${renderStep('05', '검수·클리어', '의뢰자가 결과를 검수하고 완료를 확정하면 보상 지급과 리뷰로 이어집니다.')}
      </div>
      <div class="cta-inner"><div><span class="eyebrow">START</span><h2>원하는 방식으로 시작하세요</h2><p>문제를 올리거나 공개된 미션에 TEASER로 도전할 수 있습니다.</p></div><div class="cta-actions"><button class="btn btn-primary btn-lg" data-route="create">미션 등록</button><button class="btn btn-outline btn-lg" data-route="explore">미션 찾기</button></div></div>
    </div></section>`;
}

function renderTrustSafety() {
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">TRUST & SAFETY</span><h1>신뢰·안전</h1><p>프로필 문구보다 실제 검증·이행·평가·제재 기록을 근거로 판단합니다.</p></div></section>
    <section class="page-section"><div class="container trust-section-grid">
      <div><span class="eyebrow">TRUST BY ACTION</span><h2>말보다 실제 이행기록으로 신뢰를 만듭니다</h2><p class="section-description">의뢰자의 Funding 이행, 도전자의 수행완료, 상호리뷰, 분쟁 귀책과 Strike가 역할별 TRUST 이력에 반영됩니다.</p><button class="btn btn-primary" type="button" data-route="profile">보상 확인</button></div>
      <div class="trust-feature-grid">
        ${renderTrustFeature('✓', '양방향 평가', '의뢰자와 도전자가 서로의 정확성·응답·이행을 평가합니다.')}
        ${renderTrustFeature('₩', '지급 이력', '실제 Funding·지급 완료 횟수와 누적액을 분리해 보여줍니다.')}
        ${renderTrustFeature('3', '3-Strike', '일반 미이행은 단계적으로 제한하고 중대한 사기는 즉시 차단합니다.')}
        ${renderTrustFeature('▤', '자격 검증', '본인·사업자·전문자격 배지는 TRUST 점수와 별도로 표시합니다.')}
      </div>
    </div></section>
    <section class="page-section section-soft"><div class="container"><div class="notice-box"><span>!</span><div><strong>결제·지급 기능은 승인 전까지 서버에서 차단됩니다</strong><p>PG·지급대행과 웹훅 검증이 완료되기 전에는 실제 입금·Funding·정산이 실행되지 않습니다.</p></div></div></div></section>`;
}

function renderHeroChallenge(challenge, isLive = false) {
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.BUSINESS;
  return `<button class="hero-challenge category-${challenge.category.toLowerCase()}${isLive ? ' live-card-enter' : ''}" type="button" data-challenge-id="${challenge.id}"${isLive ? ' data-live-challenge' : ''} style="--category-color:${category.color}">
    <span class="category-label"><i>${category.icon}</i>${category.label}</span>
    <h3>${escapeHTML(challenge.title)}</h3>
    <p>${escapeHTML(challenge.summary)}</p>
    <div class="hero-challenge-bottom"><div><small>미션 보상금</small><strong>${formatWon(challenge.rewardAmount)}</strong></div><span>${challenge.teaserCount} TEASER</span></div>
  </button>`;
}

function renderExplore() {
  const filtered = getFilteredChallenges();
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">EXPLORE</span><h1>미션 찾기</h1><p>내가 해결할 수 있는 문제를 찾고 TEASER로 가능성을 보여주세요.</p></div></section>
    <section class="page-section"><div class="container">
      <div class="explore-toolbar">
        <div class="search-box"><span class="search-icon" aria-hidden="true"><svg viewBox="0 0 24 24" focusable="false"><circle cx="10.8" cy="10.8" r="6.3"></circle><path d="m15.5 15.5 4.3 4.3"></path></svg></span><input id="explore-search" value="${escapeAttribute(state.search)}" placeholder="사람·업체·정보 등을 검색하세요" aria-label="미션 검색" /></div>
        <select id="explore-sort" aria-label="정렬"><option value="new">최신순</option><option value="reward">보상금 높은순</option><option value="deadline">마감임박순</option><option value="popular">인기순</option></select>
      </div>
      <div class="category-tabs">${Object.entries(CATEGORY_META).map(([key, meta]) => `<button type="button" class="${state.category === key ? 'active' : ''} category-${key.toLowerCase()}" data-category="${key}" style="--category-color:${meta.color}"><span>${meta.icon}</span>${meta.label}</button>`).join('')}</div>
      <div class="result-head"><strong id="explore-result-count">${filtered.length}개 미션</strong><span>보상금 상태와 의뢰자 TRUST를 확인한 뒤 참가하세요.</span></div>
      <div id="explore-grid">${filtered.length ? `<div class="challenge-grid">${filtered.map(renderChallengeCard).join('')}</div>` : renderEmpty('검색 결과가 없습니다', '다른 검색어나 카테고리를 선택해보세요.')}</div>
    </div></section>`;
}

const CARD_THEME_BY_CATEGORY = {
  CONNECT: 'connect', FIND: 'find', IDEA: 'idea', BUSINESS: 'business',
  ACTION: 'action', LOCAL: 'local', SOCIAL: 'social', PUBLIC: 'public',
};

const CARD_THEME_COPY = {
  connect: '사람과 기회를 잇는 미션',
  find: '필요한 정보와 대상을 찾는 미션',
  idea: '새로운 해결책을 만드는 미션',
  business: '사업 성과로 이어지는 미션',
  action: '직접 실행해 변화를 만드는 미션',
  local: '지역의 문제를 해결하는 미션',
  social: '공동체와 사회를 위한 미션',
  public: '공공의 가치를 높이는 미션',
};

function challengeCardTheme(category) {
  return CARD_THEME_BY_CATEGORY[category] || 'business';
}

function renderChallengeCard(challenge) {
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.BUSINESS;
  const cardTheme = challengeCardTheme(challenge.category);
  const status = challenge.moderationPending ? { label: '관리자 검토 대기', className: 'status-review' } : (STATUS_META[challenge.status] || { label: challenge.status, className: '' });
  const funding = fundingDisplay(challenge);
  const trustScore = Math.max(0, Math.min(100, Number(challenge.owner?.trustScore ?? 50)));
  const remainingDays = daysLeft(challenge.deadline);
  const deadlineLabel = remainingDays < 0 ? '마감' : (remainingDays === 0 ? 'D-DAY' : `D-${remainingDays}`);
  const participantCount = Number(challenge.participantCount || 0).toLocaleString('ko-KR');
  const teaserCount = Number(challenge.teaserCount || 0).toLocaleString('ko-KR');
  return `<article class="challenge-card category-${challenge.category.toLowerCase()} card-theme-${cardTheme}" role="button" tabindex="0" data-challenge-id="${challenge.id}" data-card-theme="${cardTheme}" style="--category-color:${category.color}" aria-label="${escapeAttribute(challenge.title)} 상세 보기">
    <div class="challenge-visual"><span class="challenge-visual-icon" aria-hidden="true">${category.icon}</span><span class="challenge-visual-copy"><strong>${escapeHTML(category.label)} 미션</strong><small>${CARD_THEME_COPY[cardTheme]}</small></span><span class="status-badge challenge-visual-status ${status.className}">${status.label}</span></div>
    <div class="challenge-card-copy"><h3>${escapeHTML(challenge.title)}</h3><p>${escapeHTML(challenge.summary)}</p></div>
    <div class="challenge-impact" aria-label="미션 핵심 지표">
      <div class="impact-metrics"><span><small>참여</small><strong>${participantCount}<em>명</em></strong></span><span><small>TEASER</small><strong>${teaserCount}<em>건</em></strong></span></div>
      <button class="challenge-trust-ring" type="button" data-action="view-public-profile" data-user-id="${escapeAttribute(challenge.ownerId || '')}" style="--trust-score:${trustScore * 3.6}deg" aria-label="${escapeAttribute(challenge.owner?.displayName || '의뢰자')} 클리어 신뢰도 ${trustScore}점 상세 보기"><span>클리어<br>신뢰도</span><strong>${trustScore}<small>/100</small></strong></button>
    </div>
    <div class="challenge-meta"><span><b>지역</b>${escapeHTML(challenge.region || '전국·온라인')}</span><span><b>마감</b>${deadlineLabel}</span></div>
    <div class="challenge-owner"><button class="profile-trigger" type="button" data-action="view-public-profile" data-user-id="${escapeAttribute(challenge.ownerId || '')}"><span class="avatar avatar-sm avatar-category" aria-hidden="true">${category.icon}</span><span><strong>${escapeHTML(challenge.owner?.displayName || '의뢰자')}</strong><small>의뢰자 · Strike ${challenge.owner?.strikes ?? 0}/3</small></span></button></div>
    <div class="challenge-card-bottom"><div><small>미션 보상금</small><strong>${formatWon(challenge.rewardAmount)}</strong></div><div class="funding-pill ${funding.funded ? 'funded' : ''}">${funding.funded ? '✓' : '○'} ${funding.label}</div><span class="challenge-open-arrow" aria-hidden="true">→</span></div>
  </article>`;
}

function renderCreate() {
  if (!state.user) return renderLoginRequired('미션을 만들려면 로그인해주세요', '의뢰자 이력과 Funding 약속이 TRUST에 기록됩니다.');
  const { min, max } = rewardBoundsForUser();
  const minDate = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const easy = state.createMode !== 'direct';
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">미션 등록</span><h1>미션 등록</h1><p>${easy ? '몇 가지만 선택하면 미션 글을 자동으로 완성해드립니다.' : '결과와 기준을 직접 구체적으로 작성할 수 있습니다.'}</p></div></section>
    <section class="page-section"><div class="container create-layout">
      <form class="form-card" id="challenge-create-form">
        <div class="notice-box"><span>✓</span><div><strong>이번 의뢰의 활동 주체를 선택하세요</strong><p>회원 계정 종류가 아니라 이 미션에서의 자격입니다. 보유한 유효 인증은 수행자 활동에서도 다시 사용됩니다.</p></div></div>
        <div class="field full activity-subject-field"><label>의뢰 활동 주체 <span class="required">*</span></label><select name="subjectType" required><option value="individual">개인</option><option value="business">개인사업자</option><option value="corporation">법인</option><option value="organization">단체</option></select><small>부족한 인증만 안내하며, 외부 인증기관 연결 전에는 인증 완료로 표시하지 않습니다.</small></div>
        <div class="create-mode-label"><strong>작성 방법을 선택하세요</strong><span>글쓰기가 어렵다면 간편 만들기를 이용하세요</span></div><div class="create-mode-switch" role="tablist" aria-label="작성 방식"><button type="button" role="tab" aria-selected="${easy}" class="${easy ? 'active' : ''}" data-action="create-mode" data-mode="easy"><b>추천</b><strong>간편 만들기</strong><span>몇 가지만 고르면 전체 글 자동 완성</span></button><button type="button" role="tab" aria-selected="${!easy}" class="${!easy ? 'active' : ''}" data-action="create-mode" data-mode="direct"><strong>직접 작성</strong><span>모든 내용을 직접 입력</span></button></div>
        ${easy ? renderEasyCreateWizard(max) : ''}
        <div class="form-section"><div class="form-section-head"><span>1</span><div><h2>문제와 목표</h2><p>사람들이 바로 이해할 수 있게 작성해주세요.</p></div></div>
          <div class="form-grid">
            <div class="field full"><label>미션 제목 <span class="required">*</span></label><input name="title" required minlength="5" maxlength="90" placeholder="예: 친환경 포장재 제조사를 찾아주세요" /></div>
            <div class="field full"><label>한 줄 요약 <span class="required">*</span></label><input name="summary" required minlength="10" maxlength="180" /></div>
            <div class="field full"><label>상세 설명 <span class="required">*</span></label><textarea name="description" required minlength="20" maxlength="4000" rows="6"></textarea></div>
            <div class="field"><label>카테고리 <span class="required">*</span></label><select name="category" required>${Object.entries(CATEGORY_META).filter(([key]) => key !== 'ALL').map(([key, meta]) => `<option value="${key}">${meta.label} · ${meta.desc || ''}</option>`).join('')}</select></div>
            <div class="field"><label>지역</label><input name="region" maxlength="80" value="전국·온라인" /></div>
          </div>
        </div>
        <div class="form-section"><div class="form-section-head"><span>2</span><div><h2>보상금과 일정</h2><p>등록 시에는 표시되고, FINALIST 선정 후 Funding 단계가 시작됩니다.</p></div></div>
          <div class="form-grid reward-schedule-grid"><div class="field"><label>보상금 <span class="required">*</span></label><input name="rewardAmount" type="number" min="${min}" max="${max}" step="1" required value="100000" /><small>최소 ${formatWon(min)} · 최대 ${formatWon(max)} · 고액 보상금도 전체 위험요소를 종합해 자동 판정</small></div><div class="field"><label>마감일 <span class="required">*</span></label><input name="deadline" type="date" min="${minDate}" required /></div></div>
        </div>
        <div class="form-section"><div class="form-section-head"><span>3</span><div><h2>성공·보상금 준비 기준</h2><p>분쟁을 막는 가장 중요한 약속 정보입니다.</p></div></div>
          ${easy ? renderCriteriaCheckBuilder() : ''}
          <div class="form-grid">
            <div class="field full"><label>성공조건 <span class="required">*</span></label><textarea name="successCriteria" required minlength="10" maxlength="1600" rows="4" placeholder="어떤 결과가 발생하면 성공인지 객관적으로 작성"></textarea></div>
            <div class="field full"><label>보상금 준비 시점 <span class="required">*</span></label><textarea name="paymentTrigger" required minlength="10" maxlength="800" rows="3" placeholder="예: 의뢰자가 최종 후보를 선택한 시점"></textarea></div>
            <div class="field full"><label>필수 증빙 <span class="required">*</span></label><textarea name="evidenceRequirements" required minlength="5" maxlength="800" rows="3"></textarea></div>
            <div class="field"><label>공개범위</label><select name="visibility"><option value="public">전체 공개</option><option value="unlisted">링크 공개</option><option value="private">비공개</option></select></div>
          </div>
        </div>
        <div class="notice-box"><span>!</span><div><strong>등록 즉시 자동 검수합니다</strong><p>위험도 0~29는 자동 공개, 30~59는 구체적인 자동 수정요청, 60~100 또는 금지항목은 자동 거절·비공개 보관됩니다. 수정하면 즉시 다시 검수합니다.</p></div></div>
        <label class="check-row"><input type="checkbox" name="rulesAccepted" required /><span>성공조건·보상금·운영정책과 10% 플랫폼 이용수수료를 확인했습니다.</span></label>
        <button class="btn btn-primary btn-lg btn-block" type="submit">미션 등록하기</button>
      </form>
      <aside class="preview-card"><span class="eyebrow">LIVE PREVIEW</span><h3 id="preview-title">새 미션</h3><div class="preview-list"><div class="preview-row"><span>카테고리</span><strong id="preview-category">연결</strong></div><div class="preview-row"><span>표시 보상금</span><strong id="preview-reward">100,000원</strong></div><div class="preview-row"><span>성공자 예상 지급</span><strong id="preview-payout">90,000원</strong></div><div class="preview-row"><span>현재 상태</span><strong>POSTED · 미확보</strong></div></div></aside>
    </div></section>`;
}

function renderCriteriaCheckBuilder() {
  return `<section class="criteria-check-builder"><div class="criteria-check-head"><strong>어려운 문장 대신 해당하는 항목만 체크하세요</strong><span>선택할 때마다 아래 문장이 자동으로 완성됩니다.</span></div>
    <fieldset><legend><b>① 언제 성공한 것으로 볼까요?</b><small>여러 개 선택 가능</small></legend><div class="criteria-option-grid">
      <label><input type="checkbox" name="successCheck" value="요청한 최종 결과물이 제출됨" checked /><span>결과물 제출</span></label>
      <label><input type="checkbox" name="successCheck" value="약속한 수량과 규격을 모두 충족함" checked /><span>수량·규격 충족</span></label>
      <label><input type="checkbox" name="successCheck" value="상대방의 동의를 받은 담당자 연결이 완료됨" /><span>담당자 연결</span></label>
      <label><input type="checkbox" name="successCheck" value="약속한 공식 미팅이 완료됨" /><span>미팅 완료</span></label>
      <label><input type="checkbox" name="successCheck" value="약속한 현장 또는 온라인 활동이 완료됨" /><span>실행 완료</span></label>
      <label><input type="checkbox" name="successCheck" value="사전에 제시한 품질 기준을 충족함" /><span>품질 기준 충족</span></label>
    </div></fieldset>
    <fieldset><legend><b>② 보상금은 언제 준비할까요?</b><small>한 개 선택</small></legend><div class="criteria-option-grid three">
      <label><input type="radio" name="paymentCheck" value="의뢰자가 TEASER를 검토하고 최종 수행자를 선정한 직후, 실제 수행을 시작하기 전에 보상금 준비 절차를 진행합니다." checked /><span>최종 후보 선정 직후</span></label>
      <label><input type="radio" name="paymentCheck" value="최종 수행자가 작업계획과 일정을 확정한 뒤, 실제 작업을 시작하기 전에 보상금 준비 절차를 진행합니다." /><span>작업 시작 전</span></label>
      <label><input type="radio" name="paymentCheck" value="의뢰자와 최종 수행자가 수행범위와 조건을 최종 확인한 직후 보상금 준비 절차를 진행합니다." /><span>조건 확인 직후</span></label>
    </div></fieldset>
    <fieldset><legend><b>③ 어떤 자료로 완료를 확인할까요?</b><small>여러 개 선택 가능</small></legend><div class="criteria-option-grid">
      <label><input type="checkbox" name="evidenceCheck" value="수정 가능한 최종 원본 파일" checked /><span>원본 파일</span></label>
      <label><input type="checkbox" name="evidenceCheck" value="사실을 확인할 수 있는 공식자료와 출처 링크" /><span>공식 링크</span></label>
      <label><input type="checkbox" name="evidenceCheck" value="조건별 결과를 정리한 비교표" /><span>비교표</span></label>
      <label><input type="checkbox" name="evidenceCheck" value="상대방 동의가 확인되는 연락 또는 미팅 기록" /><span>연락·미팅 기록</span></label>
      <label><input type="checkbox" name="evidenceCheck" value="날짜와 내용을 확인할 수 있는 사진 또는 영상" /><span>사진·영상</span></label>
      <label><input type="checkbox" name="evidenceCheck" value="양측이 확인한 완료확인서" /><span>완료확인서</span></label>
    </div></fieldset>
    <div class="criteria-auto-note"><i>✓</i><span>체크 결과가 아래 입력칸에 자동으로 반영됩니다. 자동 작성 후 문장을 직접 고쳐도 됩니다.</span></div>
  </section>`;
}

function updateCriteriaFromChecks() {
  const form = document.querySelector('#challenge-create-form');
  if (!form) return;
  const success = [...form.querySelectorAll('[name="successCheck"]:checked')].map((input) => input.value);
  const payment = form.querySelector('[name="paymentCheck"]:checked')?.value || '';
  const evidence = [...form.querySelectorAll('[name="evidenceCheck"]:checked')].map((input) => input.value);
  if (success.length) form.elements.successCriteria.value = `다음 조건을 모두 충족하면 성공으로 봅니다: ${success.join(', ')}. 의뢰자가 제출 자료를 기준으로 객관적으로 확인합니다.`;
  if (payment) form.elements.paymentTrigger.value = payment;
  if (evidence.length) form.elements.evidenceRequirements.value = evidence.join(', ');
}

function renderEasyCreateWizard(max) {
  const rewardOptions = [10_000, 50_000, 100_000, 300_000, 500_000, 1_000_000, 3_000_000, 5_000_000, 10_000_000, 30_000_000, 50_000_000, 100_000_000].filter((amount) => amount >= rewardBoundsForUser().min && amount <= max);
  return `<section class="easy-wizard" aria-labelledby="easy-wizard-title"><div class="easy-wizard-head"><span>간편 작성</span><div><h2 id="easy-wizard-title">원하는 내용을 골라주세요</h2><p>선택 결과를 바탕으로 아래 글을 자동 작성하며, 완성된 글은 자유롭게 수정할 수 있습니다.</p></div></div>
    <div class="wizard-grid">
      <div class="field"><label>① 어떤 도움이 필요한가요?</label><select name="wizardPurpose"><option value="FIND">업체·상품·정보를 찾고 싶어요</option><option value="CONNECT">사람·전문가와 연결되고 싶어요</option><option value="IDEA">아이디어·해결책을 받고 싶어요</option><option value="BUSINESS">사업 문제를 해결하고 싶어요</option><option value="ACTION">사진·영상·디자인 등 결과물이 필요해요</option><option value="LOCAL">우리 지역 문제를 해결하고 싶어요</option><option value="SOCIAL">사회·공동체 활동이 필요해요</option><option value="PUBLIC">공공 문제를 조사·개선하고 싶어요</option></select></div>
      <div class="field"><label>② 무엇을 받아야 완료인가요?</label><select name="wizardResult"><option value="list">조건에 맞는 후보 목록</option><option value="meeting">담당자 연결과 미팅</option><option value="proposal">구체적인 해결 제안서</option><option value="design">완성된 디자인·콘텐츠</option><option value="execution">현장·온라인 실행 결과</option><option value="report">조사·분석 보고서</option></select></div>
      <div class="field"><label>③ 결과 수량은?</label><select name="wizardQuantity"><option value="1">완성 결과 1개</option><option value="3" selected>비교 가능한 결과 3개</option><option value="5">충분한 결과 5개</option><option value="10">폭넓은 결과 10개</option></select></div>
      <div class="field"><label>④ 확인할 증빙은?</label><select name="wizardEvidence"><option value="official">공식자료·원본 링크</option><option value="contact">연락·미팅 확인 기록</option><option value="file">원본 파일과 사용권</option><option value="photo">사진·영상·활동 기록</option><option value="report">비교표·분석자료</option></select></div>
      <div class="field"><label>⑤ 활동 지역은?</label><select name="wizardRegion"><option>전국·온라인</option><option>서울·수도권</option><option>지역 직접 입력</option></select></div>
      <div class="field"><label>⑥ 추천 보상금은?</label><select name="wizardReward">${rewardOptions.map((amount) => `<option value="${amount}" ${amount === 100_000 ? 'selected' : ''}>${formatWon(amount)}</option>`).join('')}</select></div>
      <div class="field"><label>⑦ 모집 기간은?</label><select name="wizardDays"><option value="7">7일</option><option value="14" selected>14일</option><option value="30">30일</option><option value="60">60일</option></select></div>
      <div class="field full"><label>⑧ 핵심 대상이나 주제를 한 문장으로 적어주세요</label><input name="wizardSubject" minlength="2" maxlength="100" placeholder="예: 친환경 포장재를 소량 생산할 수 있는 국내 제조사" /></div>
    </div>
    <div class="example-chips"><span>⑧ 입력 예시:</span><button type="button" data-action="select-create-example" data-example="manufacturer">제조사 찾기</button><button type="button" data-action="select-create-example" data-example="design">로고·디자인</button><button type="button" data-action="select-create-example" data-example="local">지역문제 개선</button><button type="button" data-action="select-create-example" data-example="expert">전문가 연결</button></div>
    <button class="btn btn-soft btn-lg btn-block wizard-generate" type="button" data-action="generate-challenge-draft">선택한 내용으로 미션 글 자동 작성</button>
    <p class="wizard-safety">자동 작성 후 제목·성공조건·증빙 내용을 확인하고 필요한 부분만 고치면 됩니다.</p>
  </section>`;
}

function generateChallengeDraft(button) {
  const form = document.querySelector('#challenge-create-form');
  if (!form) return;
  const purpose = form.elements.wizardPurpose.value;
  const result = form.elements.wizardResult.value;
  const quantity = Number(form.elements.wizardQuantity.value || 1);
  const evidence = form.elements.wizardEvidence.value;
  const subject = form.elements.wizardSubject.value.trim();
  if (subject.length < 2) {
    form.elements.wizardSubject.focus();
    return toast('핵심 대상이나 주제를 적어주세요', '짧은 한 문장이면 충분합니다.', 'warning');
  }
  const resultMeta = {
    list: ['후보 목록', `${quantity}개의 조건 적합 후보와 비교정보`], meeting: ['담당자 연결', '연결 수락과 공식 미팅 완료'], proposal: ['해결 제안서', `${quantity}개의 실행 가능한 개선안`],
    design: ['완성 디자인', '즉시 활용 가능한 최종 원본'], execution: ['실행 결과', '요청한 활동의 완료 결과'], report: ['조사 보고서', '근거가 포함된 비교·분석 보고서'],
  }[result];
  const evidenceText = { official: '공식자료와 원본 출처 링크', contact: '상대방 동의와 연락·미팅 완료 기록', file: '최종 원본 파일, 미리보기와 사용권 확인', photo: '날짜와 장소를 확인할 수 있는 사진·영상', report: '검증 가능한 출처가 표시된 비교표와 분석자료' }[evidence];
  const action = ['FIND', 'CONNECT'].includes(purpose) ? '찾아주세요' : purpose === 'ACTION' ? '제작해주세요' : '제안해주세요';
  form.elements.title.value = `${subject} ${action}`.slice(0, 90);
  form.elements.summary.value = `${subject}에 대해 ${resultMeta[1]}을(를) 요청합니다.`.slice(0, 180);
  form.elements.description.value = `${subject}이(가) 필요합니다. 단순한 소개가 아니라 실제 확인 가능한 ${resultMeta[0]}을(를) 받고 싶습니다. 참가자는 개인정보와 영업비밀을 가린 TEASER로 접근방법과 경험을 먼저 제시해주세요. 최종 선정 후 합의된 범위와 일정에 따라 결과를 제출합니다.`;
  form.elements.category.value = purpose;
  form.elements.region.value = form.elements.wizardRegion.value === '지역 직접 입력' ? '' : form.elements.wizardRegion.value;
  form.elements.rewardAmount.value = Math.min(Number(form.elements.wizardReward.value), rewardBoundsForUser().max);
  const deadline = new Date(Date.now() + Number(form.elements.wizardDays.value || 14) * 86400000);
  form.elements.deadline.value = deadline.toISOString().slice(0, 10);
  form.elements.successCriteria.value = `${resultMeta[1]}이(가) 제출되고, 사전에 공개한 조건을 충족했는지 의뢰자가 객관적으로 확인한 시점을 성공으로 봅니다.`;
  form.elements.paymentTrigger.value = '의뢰자가 TEASER를 검토하고 최종 수행자를 선정한 뒤, 실제 수행을 시작하기 전 보상금 준비 절차를 진행합니다.';
  form.elements.evidenceRequirements.value = evidenceText;
  updateCreatePreview();
  form.elements.title.scrollIntoView({ behavior: 'smooth', block: 'center' });
  toast('미션 글을 자동 작성했습니다', '아래 내용을 확인하고 필요한 부분만 수정하세요.', 'success');
}

function selectCreateExample(example, button) {
  const form = document.querySelector('#challenge-create-form');
  if (!form) return;
  const subjects = {
    manufacturer: '친환경 포장재를 소량 생산할 수 있는 국내 제조사',
    design: '신뢰감 있고 세련된 브랜드 로고와 활용 디자인',
    local: '주민이 체감하는 지역 보행환경 개선방안',
    expert: '사업 자문이 가능한 검증된 분야별 전문가',
  };
  if (!subjects[example]) return;
  form.elements.wizardSubject.value = subjects[example];
  form.querySelectorAll('.example-chips button').forEach((item) => item.classList.toggle('selected', item === button));
  saveCreateDraft();
  toast('⑧ 핵심 주제에 예시를 넣었습니다', '전체 글은 자동 작성 버튼을 눌러야 작성됩니다.', 'success');
}

function renderDashboard() {
  if (!state.user) return renderLoginRequired('내 클리어는 로그인 후 확인할 수 있습니다', '등록·도전·보상·알림을 한곳에서 관리하세요.');
  if (state.routeError) return renderRouteError('내 클리어를 불러오지 못했습니다', state.routeError);
  const activity = state.activity;
  if (!activity) return renderLoading();
  const owned = activity.ownedChallenges || [];
  const applied = activity.applications || [];
  const notifications = activity.notifications || [];
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">내 클리어</span><h1>${escapeHTML(state.user.displayName)}님의 클리어</h1><p>등록한 미션과 도전 현황을 관리합니다.</p><div class="page-hero-actions">${state.user.isAdmin ? '<button class="btn btn-outline" data-route="simulation">가상 결제·지급 테스트 열기</button>' : ''}<small>미션·티저 현황은 8초마다 자동 갱신됩니다.</small></div></div></section>
    <section class="page-section"><div class="container dashboard-layout">
      <div class="dashboard-main">
        <section class="dashboard-card" id="activity-owned" tabindex="-1"><div class="dashboard-card-head"><h2>내가 등록한 미션</h2><strong>${owned.length}건</strong></div><div class="activity-list">${owned.length ? owned.map(renderActivityChallenge).join('') : renderEmpty('등록한 미션이 없습니다', '첫 미션을 만들어보세요.', '<button class="btn btn-primary" data-route="create">미션 등록</button>')}</div></section>
        <section class="dashboard-card" id="activity-applied" tabindex="-1"><div class="dashboard-card-head"><h2>내가 도전한 미션</h2><strong>${applied.length}건</strong></div><div class="activity-list">${applied.length ? applied.map(renderApplicationItem).join('') : renderEmpty('도전한 미션이 없습니다', '해결할 수 있는 미션을 찾아보세요.', '<button class="btn btn-outline" data-route="explore">미션 찾기</button>')}</div></section>
      </div>
      <aside class="dashboard-side"><section class="dashboard-card"><div class="dashboard-card-head"><h3>내 TRUST</h3></div>${renderTrustGauge(state.user.trustScore, { detailed: true, userId: state.user.id })}<div class="preview-list"><div class="preview-row"><span>Strike</span><strong>${state.user.strikeCount}/3</strong></div><div class="preview-row"><span>보상금 표시한도</span><strong>${formatWon(rewardBoundsForUser().max)}</strong></div><div class="preview-row"><span>계정유형</span><strong>${accountTypeLabel(state.user.accountType)}</strong></div></div><p class="trust-activity-note">TRUST는 참여 중에도 표시되며 점수는 완료·상호평가 또는 운영제재가 확정된 뒤 반영됩니다.</p><button class="btn btn-outline btn-block" data-route="profile">상세 이력 보기</button></section>
        <section class="dashboard-card"><div class="dashboard-card-head"><h3>최근 알림</h3><strong>${notifications.filter((item) => !item.read_at).length}</strong></div><div class="notification-list">${notifications.length ? notifications.slice(0, 8).map(renderNotification).join('') : '<p class="muted">새 알림이 없습니다.</p>'}</div></section></aside>
    </div></section>`;
}

function teaserStatusBadge(status) {
  const selected = ['SHORTLISTED', 'SELECTED'].includes(status);
  return `<span class="activity-badge ${selected ? 'candidate-confirmed' : 'teaser-state'}">${selected ? '✓ ' : ''}${escapeHTML(teaserStatusLabel(status))}</span>`;
}

function renderActivityChallenge(challenge) {
  const status = challenge.moderationPending ? { label: '관리자 검토 대기' } : (STATUS_META[challenge.status] || { label: challenge.status });
  const funding = fundingDisplay(challenge);
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.ALL;
  return `<button class="activity-item" type="button" data-challenge-id="${escapeAttribute(challenge.id)}" style="--activity-color:${category.color}"><span class="activity-icon">${category.icon}</span><span class="activity-copy"><strong>${escapeHTML(challenge.title)}</strong></span><span class="activity-badges"><span class="activity-badge">${escapeHTML(status.label)}</span><span class="activity-badge ${funding.funded ? 'funding-ready' : 'funding-pending'}">${escapeHTML(funding.label)}</span><span class="activity-badge">티저 ${Number(challenge.teaserCount || 0)}건</span></span><span class="application-headline activity-progress">현재 진행: ${escapeHTML(workflowStageLabel(challenge))}</span><span class="activity-money"><strong>${formatWon(challenge.rewardAmount)}</strong><small>${daysLeft(challenge.deadline) < 0 ? '마감' : `D-${daysLeft(challenge.deadline)}`}</small></span></button>`;
}

function renderApplicationItem(item) {
  const challenge = item.challenge;
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.ALL;
  return `<article class="application-item"><div class="activity-item application-summary" style="--activity-color:${category.color}"><span class="activity-icon">${category.icon}</span><span class="activity-copy"><strong>${escapeHTML(challenge.title)}</strong></span><span class="activity-badges">${teaserStatusBadge(item.teaserStatus)}<span class="activity-badge">미션 · ${escapeHTML(STATUS_META[challenge.status]?.label || challenge.status)}</span></span><span class="application-details"><span class="application-headline"><b>내 제안</b> · ${escapeHTML(item.teaserHeadline || '제출한 제안')}</span><span class="activity-progress">현재 진행: ${escapeHTML(workflowStageLabel(challenge))}</span></span><span class="activity-money"><strong>${formatWon(challenge.rewardAmount)}</strong><small>${formatDate(item.teaserCreatedAt)}</small></span></div><div class="application-links"><button type="button" class="btn btn-primary btn-small" data-action="view-my-teaser" data-challenge-id="${escapeAttribute(challenge.id)}">내 티저 보기</button><button type="button" class="btn btn-outline btn-small" data-action="view-challenge-content" data-challenge-id="${escapeAttribute(challenge.id)}">미션 전체 내용</button><button type="button" class="btn btn-soft btn-small" data-action="view-progress" data-challenge-id="${escapeAttribute(challenge.id)}">진행상황</button></div></article>`;
}

function workflowStageLabel(challenge) {
  if (challenge.moderationPending) return '관리자 검토 대기';
  if (challenge.status === 'DRAFT') return '비공개 초안';
  if (['OPEN', 'REVIEW'].includes(challenge.status)) return '티저 접수 중';
  if (challenge.status === 'SHORTLISTED') return '수행자 후보 1명 선택';
  if (challenge.status === 'FUNDING_REQUIRED') return '보상금 확보 대기';
  if (['FUNDED', 'EXECUTING'].includes(challenge.status)) return '선정 수행자 진행 중';
  if (challenge.status === 'PROOF_SUBMITTED') return '결과 검수 대기';
  if (challenge.status === 'SUCCESS') return challenge.fundingStatus === 'PAID' ? '완료·지급 완료' : '완료·지급 대기';
  return STATUS_META[challenge.status]?.label || challenge.status;
}

function renderNotification(item) {
  return `<button class="notification-item ${item.read_at ? '' : 'unread'}" type="button" data-action="open-notification" data-notification-id="${escapeAttribute(item.id)}" ${item.resource_id ? `data-challenge-id="${escapeAttribute(item.resource_id)}"` : ''}><strong>${escapeHTML(legacyNotificationText(item.title))}</strong><p>${escapeHTML(legacyNotificationText(item.body))}</p><small>${relativeDate(item.created_at)}</small></button>`;
}

async function openNotification(notificationId, challengeId) {
  await apiClient.markNotificationRead(notificationId);
  state.activity = await apiClient.activity();
  if (challengeId) return openChallenge(challengeId);
  render();
}

function rewardBoundsForUser() {
  return { min: Number(state.config?.rewardBounds?.min || 10000), max: Math.min(Number(state.config?.rewardBounds?.max || 100000000), Number(state.user?.bountyLimit ?? 100000000)) };
}

function moderationRewardThreshold() {
  return Number(state.config?.moderationRewardThreshold || 500000);
}

function openOwnedChallenges() { return openActivitySection('owned'); }
function openActivitySection(section) {
  state.activityFocus = section;
  navigate('dashboard');
}
function focusActivitySection() {
  if (state.route !== 'dashboard' || !state.activityFocus) return;
  const section = document.querySelector(`#activity-${state.activityFocus}`);
  if (!section) return;
  state.activityFocus = null;
  requestAnimationFrame(() => {
    if (!section.isConnected) return;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}

function openTrustGuide() {
  openModal(`<div class="trust-guide-modal"><span class="auth-icon">◇</span><h3>TRUST 산정 근거</h3><p>기존 점수는 보존됩니다. 새 인증·활동 항목의 점수와 가중치는 아직 확정하지 않았으며 관리자 정책이 설정되기 전에는 임의 계산하지 않습니다.</p><div class="preview-list"><div class="preview-row"><span>확인된 인증</span><strong>유효한 기관 인증 결과만</strong></div><div class="preview-row"><span>의뢰 활동</span><strong>등록·완료·취소·분쟁 이력</strong></div><div class="preview-row"><span>수행 활동</span><strong>참여·선정·완료·평가 이력</strong></div><div class="preview-row"><span>가중치</span><strong>정책 미확정</strong></div></div><p class="form-hint">개인정보·인증번호·증빙 원문·내부 검증값은 공개 프로필에 표시하지 않습니다.</p></div>`, { title: 'TRUST 확인 기준' });
}

const VERIFICATION_LABELS = { IDENTITY: '본인확인', BUSINESS: '사업자확인', CORPORATION: '법인확인', ORGANIZATION: '단체확인' };

async function openVerificationManager() {
  openModal(renderModalLoading(), { title: '인증·공개정보 관리', wide: true });
  try {
    state.verifications = await apiClient.myVerifications();
    const data = state.verifications;
    const types = ['individual', 'business', 'corporation', 'organization'];
    const statusByKey = new Map((data.verifications || []).map((item) => [`${item.subjectType}:${item.type}`, item]));
    const panels = types.map((subjectType) => `<section class="dashboard-card"><div class="dashboard-card-head"><h3>${accountTypeLabel(subjectType)} 활동</h3><strong>의뢰·수행 공통</strong></div><div class="preview-list">${(data.requirementsBySubjectType?.[subjectType] || []).map((type) => {
      const item = statusByKey.get(`${subjectType}:${type}`) || [...statusByKey.values()].find((value) => type === 'IDENTITY' && value.type === 'IDENTITY');
      const status = item?.status || 'UNVERIFIED';
      return `<div class="preview-row"><span>${VERIFICATION_LABELS[type] || type}</span><strong>${status === 'VERIFIED' ? '인증 완료·재사용 가능' : status === 'PROVIDER_REQUIRED' ? '기관 연결 필요' : status}</strong>${status !== 'VERIFIED' ? `<button class="btn btn-outline btn-small" type="button" data-action="request-verification" data-verification-type="${type}" data-subject-type="${subjectType}">인증 안내</button>` : ''}</div>`;
    }).join('')}</div></section>`).join('');
    openModal(`<div class="verification-manager"><div class="notice-box ${data.providerConnectionRequired ? 'warning' : ''}"><span>i</span><div><strong>회원 기준으로 인증을 한 번만 관리합니다</strong><p>의뢰자용·수행자용 인증을 중복 생성하지 않습니다. 외부 인증기관 계약·API가 연결되지 않은 인증은 완료로 표시하지 않습니다.</p></div></div>${data.identityAvailable ? `<form id="identity-start-form" class="auth-form"><p>본인확인 결과의 이름·휴대전화·성인 여부를 대조하고 중복확인 식별값을 해시로 처리합니다. 인증 유효기간은 1년입니다.</p><label><input type="checkbox" name="consent" required> 본인확인 결과 조회·처리에 동의합니다.</label><button class="btn btn-primary" type="submit">본인확인 시작</button></form>` : ''}<div class="verification-grid">${panels}</div><button class="btn btn-outline" data-action="entity-cases">사업자·법인·단체 자격 신청</button><p class="privacy-note">원본 신분증·주민등록번호·통장 사본을 이 화면이나 미션에 올리지 마세요. 기관 연결 전에는 인증이 필요한 신규 의뢰·도전·선정을 진행할 수 없습니다.</p></div>`, { title: '인증·공개정보 관리', wide: true });
  } catch (error) { closeModal(); showError(error); }
}

async function requestVerification(type, subjectType) {
  const result = await apiClient.requestVerification({ type, subjectType });
  toast(result.reused ? '기존 인증을 재사용합니다' : result.providerConnectionRequired ? '외부 인증기관 연결이 필요합니다' : '인증 요청을 접수했습니다', result.providerConnectionRequired ? '현재는 인증 완료로 표시하지 않습니다.' : '상태가 변경되면 알려드립니다.', result.reused ? 'success' : 'warning');
  await openVerificationManager();
}

function simulationRole() { return state.simulationRole || 'owner'; }
function simulationAction(action, label, extra = '') {
  return `<button type="button" class="btn btn-primary" data-action="simulation-step" data-step="${action}" ${extra}>${label}</button>`;
}
function renderSimulation() {
  if (!state.user?.isAdmin) return renderLoginRequired('운영 관리자 권한이 필요합니다', '가상 결제·지급 테스트는 관리자 검수 화면에서만 이용할 수 있습니다.');
  if (state.routeError) return renderRouteError('가상 거래를 불러오지 못했습니다',state.routeError);
  const s = state.simulation;
  const role = simulationRole();
  const records = state.simulations || [];
  const statusNames = { NONE:'대기', APPROVED:'승인', FAILED:'실패 · 재시도 가능', CANCELLED:'취소', REFUNDED:'환불 완료', PROCESSING:'지급 대기', PAID:'지급 완료' };
  let actions = '';
  let needed = 'owner';
  let next = '의뢰자가 새 테스트 거래를 생성합니다.';
  if (s) {
    if (s.stage === 'OPEN') { needed='solver'; next='수행자 역할에서 가상 도전자 2명의 티저를 접수하세요.'; actions=simulationAction('SUBMIT_TEASERS','가상 티저 2건 접수'); }
    if (['REVIEW','SHORTLISTED'].includes(s.stage)) { next='의뢰자가 후보를 비교하고 최종 수행자 1명을 확정하세요.';
      actions=`<div class="simulation-candidates">${s.candidates.map(c=>`<article class="candidate-card"><h3>${escapeHTML(c.name)}</h3>${teaserStatusBadge(c.status)}<p>${escapeHTML(c.headline)}</p><div class="candidate-actions">${c.status==='SUBMITTED' ? simulationAction('SHORTLIST','후보로 선정',`data-candidate-id="${c.id}"`) : simulationAction('SELECT','최종 수행자 확정',`data-candidate-id="${c.id}"`)}</div></article>`).join('')}</div>`; }
    if (s.stage === 'FUNDING_REQUIRED') { next='의뢰자가 모의 결제창에서 승인·실패·취소를 시험하세요. 실제 청구는 0원입니다.';
      actions=`<div class="simulation-checkout"><h3>모의 결제창</h3><div class="preview-row"><span>가상 결제금액</span><strong>${formatWon(s.rewardAmount)}</strong></div><div class="preview-row"><span>실제 청구금액</span><strong>0원</strong></div><p>성과보상 총액의 10%는 서비스 이용 수수료로 공제됩니다. 가상 수행자 수령액은 ${formatWon(s.solverPayout)}입니다.</p><div class="simulation-actions">${simulationAction('PAY_APPROVE','가상 결제 승인')}${simulationAction('PAY_FAIL','결제 실패 테스트')}${simulationAction('PAY_CANCEL','결제창 취소 테스트')}</div></div>`; }
    if (s.stage === 'EXECUTING') { needed='solver'; next='선정된 가상 수행자 역할에서 결과와 증빙 내용을 제출하세요.';
      actions=`<form id="simulation-proof-form"><div class="field"><label for="simulation-proof">가상 수행 결과·증빙</label><textarea id="simulation-proof" name="proof" minlength="20" maxlength="3000" rows="5" required placeholder="완료한 결과와 성공조건 충족 내용을 20자 이상 적어주세요.">${escapeHTML(s.proof || '')}</textarea></div><button class="btn btn-primary" type="submit">가상 결과 제출</button></form>`; }
    if (s.stage === 'PROOF_SUBMITTED') { next='의뢰자가 결과를 읽고 완료 확정 또는 보완 요청을 선택하세요.';
      actions=`${readSection('제출된 가상 수행 결과',s.proof)}<div class="simulation-actions">${simulationAction('REVIEW_ACCEPT','검수 완료 · 지급 단계로')}${simulationAction('REVIEW_REJECT','보완 요청')}</div>`; }
    if (s.stage === 'SUCCESS' && s.payoutStatus !== 'PAID') { next='의뢰자 역할에서 가상 지급 성공 또는 실패를 시험하세요. 실패 후 다시 지급할 수 있습니다.';
      actions=`<div class="simulation-actions">${simulationAction('PAYOUT_SUCCESS',s.payoutStatus==='FAILED' ? '가상 지급 재시도 · 성공' : '가상 보상 지급 완료')}${simulationAction('PAYOUT_FAIL','지급 실패 테스트')}</div>`; }
    if (s.payoutStatus === 'PAID') next='가상 거래가 완료되었습니다. 거래 명세와 기록에서 결제·수수료·지급 금액을 확인하세요.';
    if (s.stage === 'CANCELLED') next=s.paymentStatus==='REFUNDED' ? '가상 결제금액이 전액 환불되었습니다. 실제 거래에는 영향이 없습니다.' : '가상 미션이 취소되었습니다. 실제 청구는 없습니다.';
  }
  const flowChallenge = s ? { status:s.stage, fundingStatus:s.payoutStatus==='PAID' ? 'PAID' : s.paymentStatus==='APPROVED' ? 'FUNDED' : 'POSTED' } : null;
  return `<section class="page-hero compact"><div class="container"><span class="eyebrow">가상 거래 전용</span><h1>결제·지급 테스트</h1><p>한 계정에서 의뢰자와 가상 수행자 역할을 바꿔 전체 과정을 시험합니다.</p></div></section><section class="page-section"><div class="container simulation-page"><div class="notice-box warning"><span>ⓘ</span><div><strong>모의 결제 · 실제 청구 및 송금 0원</strong><p>실제 결제대행사나 은행에 연결되지 않습니다. 테스트 기록은 본인에게만 보이며, 기존 미션·회원 신뢰도·매출·보상 내역에 반영되지 않습니다.</p><p>SIMULATION 기록은 실제 매출·매입이 아니므로 세금계산서·현금영수증·지출증빙이 발행되지 않습니다. 실거래 증빙 기능은 PG·회계·세무 검토 후 별도로 구성해야 합니다.</p></div></div>
    <div class="simulation-toolbar"><button class="btn btn-outline" data-action="new-simulation">새 가상 거래</button><button class="btn btn-outline" data-route="dashboard">내 클리어</button></div>
    ${s ? `<section class="dashboard-card"><span class="activity-badge candidate-confirmed">가상 거래</span><h2>${escapeHTML(s.title)}</h2><p>${escapeHTML(s.successCriteria)}</p><div class="simulation-role" role="group" aria-label="테스트 역할 선택"><button class="btn ${role==='owner'?'btn-primary':'btn-outline'}" aria-pressed="${role==='owner'}" data-action="simulation-role" data-role="owner">의뢰자 역할</button><button class="btn ${role==='solver'?'btn-primary':'btn-outline'}" aria-pressed="${role==='solver'}" data-action="simulation-role" data-role="solver">수행자 역할</button></div><div class="workflow-notice"><strong>다음 단계</strong><p>${next}</p>${actions && role!==needed ? `<button class="btn btn-primary" data-action="simulation-role" data-role="${needed}">${needed==='owner'?'의뢰자':'수행자'} 역할로 전환</button>` : ''}</div>${role===needed ? actions : ''}${role==='owner' && ['OPEN','REVIEW','SHORTLISTED','FUNDING_REQUIRED'].includes(s.stage) ? `<div class="simulation-secondary">${simulationAction('CANCEL','가상 미션 취소')}</div>` : ''}${role==='owner' && ['EXECUTING','PROOF_SUBMITTED'].includes(s.stage) ? `<div class="simulation-secondary">${simulationAction('REFUND','가상 결제 전액 환불')}</div>` : ''}</section>
    <div class="simulation-summary"><section class="dashboard-card"><h2>가상 거래 명세</h2><div class="preview-list"><div class="preview-row"><span>가상 보상금 총액</span><strong>${formatWon(s.rewardAmount)}</strong></div><div class="preview-row"><span>서비스 수수료 10%</span><strong>${formatWon(s.platformFee)}</strong></div><div class="preview-row"><span>가상 수행자 수령액</span><strong>${formatWon(s.solverPayout)}</strong></div><div class="preview-row"><span>모의 결제</span><strong>${statusNames[s.paymentStatus]}</strong></div><div class="preview-row"><span>모의 지급</span><strong>${statusNames[s.payoutStatus]}</strong></div><div class="preview-row"><span>실제 청구·송금</span><strong>0원</strong></div></div><small class="simulation-id">테스트 거래번호 ${escapeHTML(s.id)}</small></section><section class="dashboard-card"><h2>가상 진행 단계</h2>${renderFlow(flowChallenge)}</section></div>
    <section class="dashboard-card"><h2>모의 승인·지급 기록</h2>${s.transactions.length ? s.transactions.map(t=>`<article class="simulation-receipt"><strong>${({PAYMENT:'가상 결제',PAYOUT:'가상 지급',REFUND:'가상 환불'})[t.kind]} · ${statusNames[t.status]}</strong><span>테스트 금액 ${formatWon(t.amount)} / 실제 거래 0원</span><small>${escapeHTML(t.id)} · ${formatDateTime(t.at)}</small></article>`).join('') : '<p>아직 거래 기록이 없습니다.</p>'}<details><summary>전체 테스트 이력 (${s.events.length}건)</summary><ol class="simulation-events">${s.events.map(e=>`<li><strong>${escapeHTML(e.label)}</strong><small>${formatDateTime(e.at)}</small></li>`).join('')}</ol></details></section>` : `<section class="dashboard-card">${renderEmpty('새 가상 거래를 시작하세요','티저 접수부터 결제·수행·검수·지급까지 직접 시험할 수 있습니다.','<button class="btn btn-primary" data-action="new-simulation">가상 거래 만들기</button>')}</section>`}
    <section class="dashboard-card"><h2>내 테스트 거래 ${records.length}건</h2><div class="simulation-history">${records.map(r=>`<button class="btn btn-outline" data-action="load-simulation" data-simulation-id="${r.id}" ${s?.id===r.id ? 'aria-current="true"' : ''}><span>${escapeHTML(r.title)}</span><small>${r.payoutStatus==='PAID'?'가상 지급 완료':r.stage==='CANCELLED'?'취소':STATUS_META[r.stage]?.label || r.stage} · ${formatWon(r.rewardAmount)}</small></button>`).join('') || '<p>저장된 거래가 없습니다.</p>'}</div></section></div></section>`;
}
function openSimulationCreate() {
  openModal(`<form id="simulation-create-form"><div class="notice-box warning"><span>ⓘ</span><div><strong>실제 돈이 오가지 않는 가상 거래입니다</strong><p>가상 도전자 2명으로 후보선정부터 지급까지 테스트합니다.</p></div></div><div class="field"><label for="sim-title">테스트 미션명</label><input id="sim-title" name="title" maxlength="90" required value="가상 거래 · 결과물 제작 미션"></div><div class="field"><label for="sim-reward">가상 보상금 (원)</label><input id="sim-reward" name="rewardAmount" type="number" min="10000" max="100000000" step="1" required value="100000"></div><button class="btn btn-primary btn-block" type="submit">가상 거래 생성</button></form>`,{title:'새 가상 거래'});
}
async function createSimulation(data, requestId) {
  const result=await apiClient.createSimulation({...data,requestId});
  state.simulation=result.simulation;state.simulationRole='owner';
  navigate(`simulation?id=${encodeURIComponent(result.simulation.id)}`);
}
async function submitSimulationCreate(form) {
  form.dataset.requestId ||= crypto.randomUUID();
  const fields=Object.fromEntries(new FormData(form));
  await createSimulation({title:fields.title,rewardAmount:Number(fields.rewardAmount)},form.dataset.requestId);
}
async function runSimulationAction(action, extra = {}, control) {
  const s=state.simulation;
  if (!s) return;
  if (control) control.dataset.requestId ||= crypto.randomUUID();
  try {
    const result=await apiClient.actSimulation(s.id,{action,role:simulationRole(),revision:s.revision,requestId:control?.dataset.requestId || crypto.randomUUID(),...extra});
    state.simulation=result.simulation;
    state.simulations=(state.simulations || []).map(r=>r.id===s.id ? result.simulation : r);
    render();
    toast(result.simulation.events.at(-1).label,'가상 거래 기록을 저장했습니다. 실제 돈은 이동하지 않습니다.','success');
  } catch(error) {
    if(error.code==='SIMULATION_CHANGED') { await loadRouteData();render(); }
    throw error;
  }
}


function renderProfile() {
  if (!state.user) return renderLoginRequired('TRUST 프로필은 로그인 후 확인할 수 있습니다', '실제 지급·수행·리뷰 이력이 역할별 신뢰자산으로 축적됩니다.');
  if (state.routeError) return renderRouteError('TRUST 프로필을 불러오지 못했습니다', state.routeError);
  const profile = state.trustProfile;
  if (!profile) return renderLoading();
  const owner = profile.ownerStats || {};
  const solver = profile.solverStats || {};
  const review = profile.reviewStats || {};
  return `<section class="profile-hero"><div class="container profile-hero-grid"><div class="profile-identity"><span class="avatar avatar-xl ${profile.accountType !== 'individual' ? 'avatar-company' : ''}">${initial(profile.displayName)}</span><div><span class="eyebrow">TRUST PROFILE</span><h1>${escapeHTML(profile.displayName)}</h1><p>${accountTypeLabel(profile.accountType)} · ${formatDate(profile.createdAt)}부터 활동</p><div class="verify-row">${verifyBadge('본인', profile.verification?.identity)}${verifyBadge('사업자', profile.verification?.business)}${verifyBadge('전문자격', profile.verification?.professional)}</div></div></div><div class="trust-score-card">${renderTrustGauge(profile.trustScore, { detailed: true, inverse: true, userId: profile.id })}<p>Strike ${profile.strikeCount}/3</p></div></div></section>
    <section class="page-section"><div class="container profile-grid">
      <div class="profile-main"><section class="dashboard-card"><div class="dashboard-card-head"><h2>의뢰 내역</h2><strong>누적 지급 ${formatWon(owner.total_paid)}</strong></div><div class="stats-grid"><button type="button" data-action="view-owned-challenges"><strong>${owner.opened || 0}</strong><span>등록 · 목록 보기</span></button><div><strong>${owner.completed || 0}</strong><span>클리어 완료</span></div><div><strong>${owner.funding_failures || 0}</strong><span>Funding 미이행</span></div></div></section>
      <section class="dashboard-card"><div class="dashboard-card-head"><h2>도전·보상 내역</h2><strong>누적 보상 ${formatWon(solver.earned)}</strong></div><div class="stats-grid"><button type="button" data-action="view-applied-challenges"><strong>${solver.teasers || 0}</strong><span>TEASER · 목록 보기</span></button><div><strong>${solver.shortlisted || 0}</strong><span>후보선정</span></div><div><strong>${solver.successes || 0}</strong><span>성공</span></div></div></section>
      <section class="dashboard-card"><div class="dashboard-card-head"><h2>최근 리뷰</h2><strong>${review.average_rating || '-'} / 5</strong></div>${profile.recentReviews?.length ? profile.recentReviews.map((item) => `<article class="review-item"><div class="review-item-head"><span class="stars">${stars(Number(item.rating))}</span><small>${formatDate(item.created_at)}</small></div><p>${escapeHTML(item.comment || '평가 내용 없음')}</p></article>`).join('') : renderEmpty('아직 리뷰가 없습니다', '첫 성공 거래 후 상호리뷰가 기록됩니다.')}</section></div>
      <aside class="profile-side"><section class="dashboard-card"><h3>신뢰의 근거</h3><div class="preview-list"><div class="preview-row"><span>평균 평가</span><strong>${review.average_rating || '-'}</strong></div><div class="preview-row"><span>리뷰 수</span><strong>${review.review_count || 0}개</strong></div><div class="preview-row"><span>다시 함께</span><strong>${review.work_again_rate ?? '-'}%</strong></div><div class="preview-row"><span>점수 공식</span><strong>${profile.trustBasis?.scoreFormulaStatus === 'UNSET' ? '정책 미확정' : '정책 적용'}</strong></div></div><button class="btn btn-primary btn-block" type="button" data-action="manage-verifications">인증·공개정보 관리</button><button class="btn btn-outline btn-block" type="button" data-action="view-trust-guide">TRUST 근거 보기</button><button class="btn btn-outline btn-block" type="button" data-action="change-password">비밀번호 변경</button></section></aside>
    </div></section>`;
}

function renderAdmin() {
  if (!state.user?.isAdmin) return renderLoginRequired('관리자 권한이 필요합니다', '운영 관리자만 접근할 수 있는 영역입니다.');
  if (state.routeError) return renderRouteError('관리자 정보를 불러오지 못했습니다', state.routeError);
  const overview = state.adminOverview;
  if (!overview) return renderLoading();
  if (overview.role === 'deputy') return renderDeputyAdmin(overview);
  const pushPanel = `<section class="page-section admin-draft-section"><div class="container"><section class="dashboard-card push-notice-card"><div class="dashboard-card-head"><div><span class="admin-kicker">PUSH NOTICE</span><h2>전체 공지 푸시</h2><p class="form-hint">푸시를 켠 활성 회원에게만 발송됩니다.<br />발송 결과는 감사 기록에 남습니다.</p></div><button class="btn btn-primary" type="button" data-action="open-push-announcement">공지 푸시 작성</button></div></section></div></section>`;
  const pushAudit = overview.pushAudit ? `<section class="page-section admin-draft-section"><div class="container"><section class="dashboard-card push-audit-card"><span class="admin-kicker">PUSH DELIVERY AUDIT</span><h2>푸시 전송 현황</h2><div class="push-audit-summary"><div><strong>${overview.pushAudit.summary.subscribed || 0}</strong><span>수신 기기</span></div><div><strong>${overview.pushAudit.summary.accepted || 0}</strong><span>최근 7일 전송 수락</span></div><div><strong>${overview.pushAudit.summary.failed || 0}</strong><span>최근 7일 실패·만료</span></div></div><p class="form-hint">전송 수락은 푸시 서비스가 받은 상태입니다. 실제 화면 표시와 앱 확인은 기기에서 별도로 확인합니다.</p></section></div></section>` : '';
  const moderationPanel = `<section class="page-section admin-draft-section"><div class="container"><section class="dashboard-card admin-moderation-card"><div class="dashboard-card-head moderation-card-head"><div><span class="admin-kicker">SAFETY REVIEW</span><h2>관리자 검토 대기</h2><p class="form-hint">저위험 미션은 자동 승인·기록되며, 고액·위험·불명확 항목만 여기에 남습니다.</p></div><div class="moderation-head-actions"><strong>${overview.moderationChallenges?.length || 0}</strong><button class="btn btn-outline btn-small" type="button" data-action="auto-review-moderation">전체 자동 재검수</button></div></div><div class="audit-table">${overview.moderationChallenges?.length ? overview.moderationChallenges.map((item) => `<div class="audit-row moderation-row"><div><strong>${escapeHTML(item.title)}</strong><span>${formatWon(item.reward_amount)} · 위험도 ${Number(item.moderation_risk_score || 0)} · ${item.moderationReasons.map((reason) => escapeHTML(reason.label)).join(' · ')}</span><small>접수 ${formatDateTime(item.created_at)} · 마감 ${formatDateTime(item.deadline)}</small></div><span class="moderation-actions"><button class="btn btn-outline btn-small" type="button" data-challenge-id="${escapeAttribute(item.id)}">내용 보기</button><button class="btn btn-danger btn-small" type="button" data-action="archive-moderation" data-challenge-id="${escapeAttribute(item.id)}">비공개 보관</button><button class="btn btn-primary btn-small" type="button" data-action="approve-moderation" data-challenge-id="${escapeAttribute(item.id)}">승인 후 공개</button></span></div>`).join('') : '<p class="muted">관리자 검토 대기 미션이 없습니다.</p>'}</div></section></div></section>`;
  const stats = overview.moderationStats || {};
  const automaticPanel = `<section class="page-section admin-draft-section"><div class="container"><section class="dashboard-card admin-moderation-card"><div class="dashboard-card-head"><div><span class="admin-kicker">AUTO MODERATION</span><h2>자동검수 처리 현황</h2><p class="form-hint">일상 승인은 시스템이 처리하며, 관리자는 이의신청·분쟁·특수 예외만 확인합니다.</p></div><strong>${Number(stats.total || 0)}</strong></div><div class="stats-grid"><div><strong>${Number(stats.auto_approved || 0)}</strong><span>자동승인</span></div><div><strong>${Number(stats.changes_required || 0)}</strong><span>자동 수정요청</span></div><div><strong>${Number(stats.auto_rejected || 0)}</strong><span>자동거절</span></div></div><div class="dashboard-card-head"><h3>이의신청·예외</h3><strong>${overview.moderationAppeals?.length || 0}</strong></div><div class="audit-table">${overview.moderationAppeals?.length ? overview.moderationAppeals.map((item) => `<button class="audit-row admin-row-button" type="button" data-challenge-id="${escapeAttribute(item.challenge_id)}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.moderation_action)} · 위험도 ${Number(item.moderation_risk_score || 0)}</span><small>${escapeHTML(item.display_name)} · ${formatDateTime(item.created_at)}</small></button>`).join('') : '<p class="muted">확인할 이의신청·예외가 없습니다.</p>'}</div></section></div></section>`;
  const draftPanel = `<section class="page-section admin-draft-section"><div class="container"><section class="dashboard-card admin-draft-card"><div class="dashboard-card-head"><div><span class="admin-kicker">DRAFT CENTER</span><h2>비공개 초안</h2><p class="form-hint">자동 수정요청·자동거절·사용자 초안을 삭제하지 않고 보존합니다.</p></div><strong>${overview.draftChallenges?.length || 0}</strong></div><div class="audit-table">${overview.draftChallenges?.length ? overview.draftChallenges.map((item) => `<button class="audit-row admin-row-button" type="button" data-challenge-id="${escapeAttribute(item.id)}"><strong>${escapeHTML(item.title)}</strong><span>초안 · 비공개 · ${formatWon(item.reward_amount)}</span><small>마감 ${formatDateTime(item.deadline)}</small></button>`).join('') : '<p class="muted">비공개 초안이 없습니다.</p>'}</div></section></div></section>`;
  return `<section class="page-hero compact admin-hero"><div class="container"><span class="eyebrow">ADMIN CONTROL</span><h1>운영 관리자</h1><button class="btn btn-outline" data-route="simulation">가상 결제·지급 테스트</button><p>회원·미션·분쟁·정산·Audit 상태를 확인합니다.</p></div></section>
    ${renderHomeThemeControls(overview)}
    ${renderLaunchReadiness(overview)}${renderAdminStaffControls(overview)}
    ${pushPanel}
    ${pushAudit}
    ${automaticPanel}
    ${draftPanel}
    <section class="page-section"><div class="container"><div class="admin-metric-grid">
      ${adminMetric('회원', overview.users?.total, `정지 ${overview.users?.suspended || 0}`)}
      ${adminMetric('미션', overview.challenges?.total, `초안 ${overview.challenges?.draft || 0} · 성공 ${overview.challenges?.success || 0}`)}
      ${adminMetric('플랫폼 매출', formatWon(overview.money?.platform_revenue), `지급 ${formatWon(overview.money?.solver_payouts)}`)}
      ${adminMetric('분쟁', overview.disputes?.open, `전체 ${overview.disputes?.total || 0}`)}
    </div><div class="admin-ops-grid"><section class="dashboard-card"><div class="dashboard-card-head"><div><h2>최근 가입 회원</h2><p class="form-hint">최고관리자만 가입·동의 정보를 조회할 수 있으며 조회 기록이 남습니다.</p></div><strong>${overview.recentUsers?.length || 0}</strong></div><div class="audit-table">${overview.recentUsers?.length ? overview.recentUsers.map((item) => `<button class="audit-row admin-row-button" type="button" data-action="view-admin-member" data-user-id="${escapeAttribute(item.id)}"><strong>${escapeHTML(item.display_name)}</strong><span>${accountTypeLabel(item.account_type)} · TRUST ${item.trust_score} · Strike ${item.strike_count}/3</span><small>${escapeHTML(item.status)} · 가입 ${formatDateTime(item.created_at)}</small></button>`).join('') : '<p class="muted">회원 기록이 없습니다.</p>'}</div></section><section class="dashboard-card"><div class="dashboard-card-head"><div><h2>처리할 분쟁</h2><p class="form-hint">처리 단계와 종결 결과는 당사자 알림·감사 기록에 남습니다.</p></div><strong>${overview.openDisputes?.length || 0}</strong></div><div class="audit-table">${overview.openDisputes?.length ? overview.openDisputes.map((item) => `<button class="audit-row admin-row-button" type="button" data-action="open-admin-dispute" data-dispute-id="${escapeAttribute(item.id)}"><strong>${escapeHTML(item.title)}</strong><span>${escapeHTML(item.reason_code)} · ${escapeHTML(item.status)}</span><small>${escapeHTML(item.opened_by_name || '-')} → ${escapeHTML(item.respondent_name || '상대방 미지정')} · ${formatDateTime(item.created_at)}</small></button>`).join('') : '<p class="muted">처리 대기 분쟁이 없습니다.</p>'}</div></section><section class="dashboard-card"><div class="dashboard-card-head"><h2>정산 대기</h2><strong>${overview.pendingSettlements?.length || 0}</strong></div><div class="audit-table">${overview.pendingSettlements?.length ? overview.pendingSettlements.map((item) => `<button class="audit-row admin-row-button" type="button" data-challenge-id="${escapeAttribute(item.challenge_id)}"><strong>${escapeHTML(item.title)}</strong><span>${formatWon(item.solver_payout)} 지급 · ${escapeHTML(item.status)}</span><small>${formatDateTime(item.created_at)}</small></button>`).join('') : '<p class="muted">처리 대기 정산이 없습니다.</p>'}</div></section><section class="dashboard-card"><div class="dashboard-card-head"><h2>최근 Audit Log</h2><strong>${overview.recentAudit?.length || 0}</strong></div><div class="audit-table">${overview.recentAudit?.length ? overview.recentAudit.map((item) => `<div class="audit-row"><strong>${escapeHTML(item.action)}</strong><span>${escapeHTML(item.resource_type)} · ${escapeHTML(item.resource_id || '-')}</span><small>${formatDateTime(item.created_at)}</small></div>`).join('') : '<p class="muted">기록이 없습니다.</p>'}</div></section></div></div></section>`;
}

function renderHomeThemeControls(overview) {
  const active = overview.homeTheme?.theme || 'original';
  return `<section class="page-section admin-theme-section"><div class="container"><div class="dashboard-card admin-theme-panel">
    <div class="dashboard-card-head"><div><span class="admin-kicker">SITE DESIGN STUDIO</span><h2>사이트 전체 디자인</h2><p class="form-hint">미리보기에서 홈과 세부 화면을 확인하세요. 적용하면 전체 페이지의 색상과 구성 요소가 함께 전환되며 기존 메뉴·미션 데이터는 유지됩니다.</p></div><span class="theme-live-label">현재 적용: ${escapeHTML(HOME_THEME_OPTIONS.find((item) => item.id === active)?.title || '오리지널 네이비')}</span></div>
    <h3 class="studio-admin-group">전체 화면 시안 · 5종</h3><div class="home-theme-grid">${HOME_THEME_OPTIONS.filter((item) => ['luxury', 'community', 'command', 'magazine', 'journey'].includes(item.id)).map((item) => `<article class="home-theme-option${active === item.id ? ' is-active' : ''}" data-theme="${item.id}">
      <div class="home-theme-swatch theme-swatch-${item.id}" aria-hidden="true"><span class="swatch-kicker">MODU CLEAR</span><strong>${escapeHTML(item.title)}</strong><i></i><span class="swatch-board">미션 찾기 <b>↗</b></span></div>
      <div class="home-theme-description"><strong>${item.title}</strong><span>${item.detail}</span></div>
      <div class="home-theme-actions"><button class="btn btn-outline btn-small" type="button" data-action="preview-home-theme" data-theme="${item.id}">미리보기</button><button class="btn btn-primary btn-small" type="button" data-action="apply-home-theme" data-theme="${item.id}" ${active === item.id ? 'disabled' : ''}>${active === item.id ? '적용 중' : '적용하기'}</button></div>
    </article>`).join('')}</div><h3 class="studio-admin-group">기존 디자인</h3><div class="home-theme-grid">${HOME_THEME_OPTIONS.filter((item) => !['luxury', 'community', 'command', 'magazine', 'journey'].includes(item.id)).map((item) => `<article class="home-theme-option${active === item.id ? ' is-active' : ''}" data-theme="${item.id}"><div class="home-theme-swatch theme-swatch-${item.id}" aria-hidden="true"><span class="swatch-kicker">MODU CLEAR</span><strong>미션을 올리고,<br>해결하고, 보상받다.</strong><i></i><span class="swatch-board">현재 공개 미션 <b>↗</b></span></div><div class="home-theme-description"><strong>${item.title}</strong><span>${item.detail}</span></div><div class="home-theme-actions"><button class="btn btn-outline btn-small" type="button" data-action="preview-home-theme" data-theme="${item.id}">미리보기</button><button class="btn btn-primary btn-small" type="button" data-action="apply-home-theme" data-theme="${item.id}" ${active === item.id ? 'disabled' : ''}>${active === item.id ? '적용 중' : '적용하기'}</button></div></article>`).join('')}</div>
  </div></div></section>`;
}

async function applyHomeTheme(theme) {
  if (state.user?.adminRole !== 'primary' || !state.adminOverview?.homeTheme) throw new ApiError('최고관리자만 디자인을 변경할 수 있습니다.', { code: 'PRIMARY_ADMIN_REQUIRED' });
  if (!HOME_THEME_OPTIONS.some((item) => item.id === theme)) return;
  const response = await apiClient.updateHomeTheme(theme, state.adminOverview.homeTheme.revision);
  state.adminOverview.homeTheme = response.homeTheme;
  state.config.homeTheme = response.homeTheme.theme;
  state.previewHomeTheme = null;
  render();
  toast('사이트 전체 디자인을 적용했습니다', '방문자가 새로 접속하면 선택한 컨셉이 모든 페이지에 표시됩니다.', 'success');
}

function renderAdminStaffControls(overview) {
  const members = overview.staffMembers || [];
  const deputies = members.filter((item) => item.admin_role === 'deputy');
  const candidates = overview.staffCandidates || [];
  return `<section class="page-section admin-staff-section"><div class="container"><div class="dashboard-card admin-staff-card"><div class="dashboard-card-head"><div><span class="eyebrow">ACCESS CONTROL</span><h2>관리자 권한 관리</h2></div><strong>최고관리자 전용</strong></div><p class="muted">최고관리자는 <strong>kpa100plus@gmail.com</strong> 계정으로 고정됩니다. 부관리자는 운영 현황 확인용 최소 권한만 받으며, 제재·정산·권한 변경은 할 수 없습니다.</p><div class="admin-staff-grid"><section><h3>현재 관리자</h3><div class="audit-table">${members.length ? members.map((item) => `<div class="audit-row"><strong>${escapeHTML(item.display_name)} <small>${item.admin_role === 'primary' ? '최고관리자' : '부관리자'}</small></strong><span>${escapeHTML(item.email || '-')}</span><small>${formatDateTime(item.created_at)}</small>${item.admin_role === 'deputy' ? `<button class="btn btn-ghost btn-small" type="button" data-action="revoke-deputy" data-user-id="${escapeAttribute(item.id)}">권한 회수</button>` : ''}</div>`).join('') : '<p class="muted">관리자 계정을 불러오지 못했습니다.</p>'}</div></section><section><h3>가입회원에서 부관리자 지정</h3><div class="audit-table">${candidates.length ? candidates.map((item) => `<div class="audit-row"><strong>${escapeHTML(item.display_name)}</strong><span>${accountTypeLabel(item.account_type)} · TRUST ${item.trust_score}</span><small>${formatDateTime(item.created_at)}</small><button class="btn btn-outline btn-small" type="button" data-action="appoint-deputy" data-user-id="${escapeAttribute(item.id)}">부관리자 지정</button></div>`).join('') : '<p class="muted">지정 가능한 가입회원이 없습니다.</p>'}</div></section></div>${deputies.length ? `<p class="form-hint">부관리자 ${deputies.length}명은 미션·회원·분쟁 현황만 확인할 수 있습니다.</p>` : '<p class="form-hint">부관리자는 아직 지정되지 않았습니다.</p>'}</div></div></section>`;
}

function renderDeputyAdmin(overview) {
  const queue = overview.moderationChallenges || [];
  return `<section class="page-hero compact admin-hero"><div class="container"><span class="eyebrow">DEPUTY ADMIN</span><h1>부관리자 검토함</h1><p>검토 의견과 승인 요청만 남길 수 있으며 최종 공개 권한은 없습니다.</p></div></section><section class="page-section"><div class="container"><div class="dashboard-card"><div class="deputy-notice"><strong>부관리자 권한</strong><span>가능: 검토 대기 확인·의견 작성·승인 요청 / 불가: 공개 승인·회원정보·제재·정산·권한 변경</span></div><div class="audit-table">${queue.length ? queue.map((item) => `<div class="audit-row moderation-row"><div><strong>${escapeHTML(item.title)}</strong><span>${item.moderationReasons.map((reason) => escapeHTML(reason.label)).join(' · ')}</span><small>${item.latest_note ? `최근 의견: ${escapeHTML(item.latest_note)}` : '아직 검토 의견이 없습니다.'}</small></div><span class="moderation-actions"><button class="btn btn-outline btn-small" type="button" data-challenge-id="${escapeAttribute(item.id)}">내용 보기</button><button class="btn btn-primary btn-small" type="button" data-action="add-moderation-note" data-challenge-id="${escapeAttribute(item.id)}">의견·승인 요청</button></span></div>`).join('') : '<p class="muted">검토 대기 미션이 없습니다.</p>'}</div></div></div></section>`;
}

async function approveModerationChallenge(challengeId) {
  if (!window.confirm('자동 사전분석 사유를 확인한 뒤 이 미션을 공개할까요? 승인 후에는 작성자가 선택한 공개 범위로 전환됩니다.')) return;
  const result = await apiClient.approveModerationChallenge(challengeId);
  state.adminOverview = (await apiClient.adminOverview()).overview;
  await loadChallenges();
  toast('검토 승인 및 공개 처리를 완료했습니다', '자동 분석은 삭제·판정을 하지 않으며, 승인 기록이 남습니다.', 'success');
  await openChallenge(result.challenge.id);
}

async function autoReviewModerationQueue() {
  const result = await apiClient.autoReviewModerationQueue();
  state.adminOverview = (await apiClient.adminOverview()).overview;
  await loadChallenges();
  render();
  toast('자동 재검수를 완료했습니다', `검수 ${result.checked}건 · 자동승인 ${result.autoApproved}건 · 관리자 유지 ${result.adminReview}건`, 'success');
}

function openModerationArchive(challengeId) {
  openModal(`<form id="moderation-archive-form" data-challenge-id="${escapeAttribute(challengeId)}"><div class="notice-box warning"><span>!</span><div><strong>삭제하지 않고 비공개로 보관합니다</strong><p>작성 내용·참여 연결·감사 기록은 유지되며 공개 목록과 검토 대기 목록에서만 제외됩니다.</p></div></div><div class="field" style="margin-top:18px"><label>비공개 보관 사유 <small>5자 이상</small></label><textarea name="reason" required minlength="5" maxlength="500" rows="5" data-count placeholder="예: 동일 요청이 중복 등록되어 나중 항목을 비공개 보관합니다."></textarea></div><button class="btn btn-danger btn-block" type="submit">기록 보존 후 비공개 처리</button></form>`, { title: '검토 항목 비공개 보관' });
}

async function submitModerationArchive(form) {
  const data = new FormData(form);
  const result = await apiClient.archiveModerationChallenge(form.dataset.challengeId, String(data.get('reason') || ''));
  closeModal();
  state.adminOverview = (await apiClient.adminOverview()).overview;
  await loadChallenges();
  render();
  toast('비공개 보관을 완료했습니다', result.idempotent ? '이미 처리된 항목이며 기록은 그대로 보존됩니다.' : '공개·검토 목록에서 제외했고 원본 기록은 보존했습니다.', 'success');
}

function openModerationAppeal(challengeId) {
  openModal(`<form id="moderation-appeal-form" data-challenge-id="${escapeAttribute(challengeId)}"><div class="notice-box warning"><span>!</span><div><strong>자동판정 오탐 근거를 제출해주세요</strong><p>합법성·안전성·권한 증빙을 구체적으로 작성한 예외만 관리자가 확인합니다.</p></div></div><div class="field" style="margin-top:18px"><label>이의신청 사유 <small>20자 이상</small></label><textarea name="reason" required minlength="20" maxlength="2000" rows="7" placeholder="예: 승인된 보안 점검 계약의 범위와 권한 근거..."></textarea></div><button class="btn btn-primary btn-block" type="submit">이의신청 제출</button></form>`, { title: '자동판정 이의신청' });
}

async function submitModerationAppeal(form) {
  const reason = String(new FormData(form).get('reason') || '').trim();
  await apiClient.createModerationAppeal(form.dataset.challengeId, reason);
  closeModal();
  toast('이의신청을 접수했습니다', '일상 미션 승인이 아니라 오탐·특수 예외만 관리자가 확인합니다.', 'success');
}

async function updateDeputy(userId, appoint) {
  if (appoint && !window.confirm('이 가입회원에게 운영 현황 조회용 부관리자 권한을 부여할까요?')) return;
  if (!appoint && !window.confirm('이 부관리자의 권한을 회수할까요?')) return;
  if (appoint) await apiClient.appointDeputy(userId);
  else await apiClient.revokeDeputy(userId);
  state.adminOverview = (await apiClient.adminOverview()).overview;
  render();
  toast('권한 관리', appoint ? '부관리자로 지정했습니다.' : '부관리자 권한을 회수했습니다.', 'success');
}

function renderLoginRequired(title, description) {
  if (title === '관리자 권한이 필요합니다' && state.user) {
    return `<section class="page-section"><div class="container">${renderEmpty('현재 계정은 관리자가 아닙니다', `로그인 계정: ${escapeHTML(state.user.email)}. 최고관리자는 kpa100plus@gmail.com 계정으로 다시 로그인해야 합니다.`, '<div class="empty-actions"><button class="btn btn-primary" data-action="logout">로그아웃</button><button class="btn btn-outline" data-route="home">홈으로</button></div>')}</div></section>`;
  }
  return `<section class="page-section"><div class="container">${renderEmpty(title, description, '<div class="empty-actions"><button class="btn btn-primary" data-action="login">로그인</button><button class="btn btn-outline" data-action="signup">회원가입</button></div>')}</div></section>`;
}

function renderLoading() {
  return `<section class="page-section"><div class="container"><div class="loading-panel"><span class="loading-spinner"></span><strong>데이터를 불러오고 있습니다</strong></div></div></section>`;
}

function renderRouteError(title, error) {
  const message = error instanceof ApiError ? error.message : '네트워크 또는 서버 연결을 확인한 뒤 다시 시도해주세요.';
  return `<section class="page-section"><div class="container">${renderEmpty(title, message, '<button class="btn btn-primary" data-action="retry-current-route">다시 시도</button>')}</div></section>`;
}

function renderNotFound() {
  return `<section class="page-section"><div class="container">${renderEmpty('페이지를 찾을 수 없습니다', '메인 화면으로 이동해주세요.', '<button class="btn btn-primary" data-route="home">홈으로</button>')}</div></section>`;
}

async function openChallenge(challengeId) {
  openModal(renderModalLoading(), { title: '미션 상세', wide: true });
  try {
    const result = await apiClient.getChallenge(challengeId);
    state.selectedChallenge = result;
    renderChallengeModal(result);
  } catch (error) {
    renderModalRequestError('미션 상세', error, 'retry-challenge-detail', { challengeId });
    showError(error);
  }
}

function renderChallengeModal(result) {
  const challenge = result.challenge;
  const context = result.context || {};
  const category = CATEGORY_META[challenge.category] || CATEGORY_META.BUSINESS;
  const status = challenge.moderationPending ? { label: '관리자 검토 대기', className: 'status-review' } : (STATUS_META[challenge.status] || { label: challenge.status, className: '' });
  const funding = fundingDisplay(challenge);
  openModal(`<nav class="detail-read-nav" aria-label="내용 바로 보기"><button type="button" class="btn btn-outline" data-action="view-challenge-content" data-challenge-id="${escapeAttribute(challenge.id)}">미션 전체 내용</button>${context.viewerTeaser ? `<button type="button" class="btn btn-primary" data-action="view-my-teaser" data-challenge-id="${escapeAttribute(challenge.id)}">내 티저 보기</button>` : ''}</nav>${renderProgressNotice(challenge, context)}<div class="detail-layout">
    <article class="detail-main">
      <div class="detail-kicker"><span class="category-label"><i>${category.icon}</i>${category.label} 미션</span><span class="status-badge ${status.className}">${status.label}</span></div>
      <h2 class="detail-title">${escapeHTML(challenge.title)}</h2><p class="detail-summary">${escapeHTML(challenge.summary)}</p>
      <div class="detail-owner"><button class="profile-trigger" type="button" data-action="view-public-profile" data-user-id="${escapeAttribute(challenge.ownerId || '')}"><span class="avatar ${challenge.owner?.businessVerified ? 'avatar-company' : ''}">${initial(challenge.owner?.displayName)}</span><span><strong>${escapeHTML(challenge.owner?.displayName || '의뢰자')}</strong><small>${verificationSummary(challenge.owner)}</small></span></button>${renderTrustGauge(challenge.owner?.trustScore, { compact: true, userId: challenge.ownerId })}</div>
      <section class="detail-section"><h3>미션 설명</h3><p>${nl2br(challenge.description)}</p></section>
      <section class="detail-section"><h3>성공·Funding 기준</h3><div class="criteria-list">
        <div class="criteria-item"><i>✓</i><div><strong>성공조건</strong><span>${nl2br(challenge.successCriteria)}</span></div></div>
        <div class="criteria-item"><i>₩</i><div><strong>Funding 시점</strong><span>${nl2br(challenge.paymentTrigger)}</span></div></div>
        <div class="criteria-item"><i>▤</i><div><strong>필수 증빙</strong><span>${nl2br(challenge.evidenceRequirements)}</span></div></div>
      </div></section>
      ${['CHANGES_REQUIRED','AUTO_REJECTED'].includes(challenge.moderationAction) && (context.isOwner || context.isAdmin) ? `<section class="detail-section"><h3>자동 검수 결과</h3><div class="notice-box warning"><span>!</span><div><strong>${challenge.moderationAction === 'CHANGES_REQUIRED' ? '내용 수정 후 즉시 자동 재검수됩니다' : '금지·고위험 항목으로 자동 거절되었습니다'}</strong><p>위험도 ${challenge.moderationRiskScore}/100 · 정책 ${escapeHTML(challenge.moderationPolicyVersion || '-')}</p><p>${challenge.moderationReasons.map((item) => escapeHTML(item.label)).join(' · ') || '검수 사유 확인 필요'}</p>${challenge.moderationGuidance?.length ? `<ul>${challenge.moderationGuidance.map((item) => `<li>${escapeHTML(item.message)}</li>`).join('')}</ul>` : ''}</div></div></section>` : ''}
      ${context.latestProof ? `<section class="detail-section"><h3>최근 결과 증빙</h3><div class="proof-box"><p>${nl2br(context.latestProof.description)}</p>${context.latestProof.evidence_url ? `<a href="${escapeAttribute(context.latestProof.evidence_url)}" target="_blank" rel="noopener">증빙 링크 열기</a>` : ''}<small>해시 ${escapeHTML(context.latestProof.evidence_hash || '-')} · ${formatDateTime(context.latestProof.submitted_at)}</small></div></section>` : ''}
      ${result.ownerReviews?.length ? `<section class="detail-section"><h3>의뢰자 최근 리뷰</h3>${result.ownerReviews.map((review) => `<article class="review-item"><div class="review-item-head"><strong>${escapeHTML(review.reviewer_name)}</strong><span class="stars">${stars(Number(review.rating))}</span></div><p>${escapeHTML(review.comment || '')}</p></article>`).join('')}</section>` : ''}
    </article>
    <aside class="detail-side"><div class="detail-side-card"><div class="reward-panel"><small>미션 보상금</small><strong>${formatWon(challenge.rewardAmount)}</strong><div class="reward-status">${funding.funded ? '✓' : '○'} ${funding.label}</div></div><div class="detail-stats"><div class="detail-stat"><strong>${challenge.participantCount}</strong><span>참가자</span></div><div class="detail-stat"><strong>${challenge.teaserCount}</strong><span>TEASER</span></div></div><div class="action-stack">${renderLiveActions(challenge, context)}</div></div>
    <div class="detail-side-card"><h3>진행단계</h3>${renderFlow(challenge, context)}</div>
    <div class="detail-side-card"><h3>의뢰자 신뢰</h3>${renderTrustGauge(challenge.owner?.trustScore, { detailed: true, userId: challenge.ownerId })}<div class="preview-list"><div class="preview-row"><span>Strike</span><strong>${challenge.owner?.strikes ?? 0}/3</strong></div><div class="preview-row"><span>본인확인</span><strong>${challenge.owner?.identityVerified ? '완료' : '미확인'}</strong></div><div class="preview-row"><span>사업자확인</span><strong>${challenge.owner?.businessVerified ? '완료' : '미확인'}</strong></div></div></div></aside>
  </div>`, { title: '미션 상세', wide: true });
}

function readSection(title, value) {
  return `<section class="read-section"><h3>${escapeHTML(title)}</h3><div class="read-content">${nl2br(value || '등록된 내용이 없습니다.')}</div></section>`;
}

async function openChallengeContent(challengeId) {
  openModal(renderModalLoading(), { title: '미션 전체 내용', wide: true });
  try {
    const result = await apiClient.getChallenge(challengeId);
    state.selectedChallenge = result;
    const c = result.challenge;
    openModal(`<article class="submission-reader"><h2>${escapeHTML(c.title)}</h2><p class="reader-summary">${escapeHTML(c.summary)}</p><div class="reader-meta"><span>보상금 ${formatWon(c.rewardAmount)}</span><span>지역 ${escapeHTML(c.region || '전국·온라인')}</span><span>마감 ${formatDate(c.deadline)}</span><span>${escapeHTML(CATEGORY_META[c.category]?.label || c.category)}</span></div>${readSection('상세 설명', c.description)}${readSection('성공조건', c.successCriteria)}${readSection('보상금 준비 시점', c.paymentTrigger)}${readSection('필수 증빙', c.evidenceRequirements)}<div class="reader-actions">${result.context?.viewerTeaser ? `<button type="button" class="btn btn-primary" data-action="view-my-teaser" data-challenge-id="${escapeAttribute(c.id)}">내 티저 보기</button>` : ''}<button type="button" class="btn btn-outline" data-challenge-id="${escapeAttribute(c.id)}">상세·진행상태로 돌아가기</button></div></article>`, { title: '미션 전체 내용', wide: true });
  } catch (error) { renderModalRequestError('미션 전체 내용', error, 'view-challenge-content', { challengeId }); }
}

async function openMyTeaser(challengeId) {
  openModal(renderModalLoading(), { title: '내 티저 보기', wide: true });
  try {
    const result = await apiClient.getMyTeaser(challengeId);
    const t = result.teaser;
    openModal(`<article class="submission-reader"><p class="reader-summary">${escapeHTML(result.challengeTitle)}</p><h2>${escapeHTML(t.headline)}</h2><div class="reader-meta">${teaserStatusBadge(t.status)}<span>제출: ${formatDateTime(t.createdAt)}</span><span>예상기간: ${Number(t.expectedDays)}일</span></div>${readSection('한 줄 제안', t.headline)}${readSection('해결능력·경험', t.capability)}${readSection('접근방법', t.approach)}${readSection('마스킹 증빙', t.maskedEvidence)}${readSection('자격 유형', t.qualificationType)}${readSection('자격 참조정보', t.qualificationRef)}<div class="reader-actions"><button type="button" class="btn btn-primary" data-challenge-id="${escapeAttribute(challengeId)}">진행상황 · 다음 단계</button><button type="button" class="btn btn-outline" data-action="view-challenge-content" data-challenge-id="${escapeAttribute(challengeId)}">미션 전체 내용</button>${t.canEdit ? `<button type="button" class="btn btn-primary" data-action="edit-teaser" data-challenge-id="${escapeAttribute(challengeId)}">TEASER 수정</button>` : '<p class="form-hint">수정이 제한된 상태에서도 제출한 내용은 확인할 수 있습니다.</p>'}<button type="button" class="btn btn-outline" data-action="view-applied-challenges">내 도전 목록</button></div></article>`, { title: '내 티저 보기', wide: true });
  } catch (error) { renderModalRequestError('내 티저 보기', error, 'retry-my-teaser', { challengeId }); }
}

function renderLiveActions(challenge, context) {
  if (!state.user) return `<button class="btn btn-primary btn-block" data-action="login">로그인하고 도전하기</button><button class="btn btn-outline btn-block" data-action="share-challenge" data-challenge-id="${challenge.id}">공유하기</button>`;
  const buttons = [`<button type="button" class="btn btn-outline btn-block" data-action="view-challenge-content" data-challenge-id="${escapeAttribute(challenge.id)}">미션 전체 내용 보기</button>`];
  if (context.isOwner || context.isAdmin) buttons.push(`<button type="button" class="btn btn-soft btn-block" data-action="start-simulation" data-challenge-id="${escapeAttribute(challenge.id)}">가상 거래로 복제해 테스트</button>`);
  if (context.isAdmin) buttons.push(`<button class="btn btn-outline btn-block" data-action="open-admin">관리기록 보기</button>`);
  if (context.isAdmin && challenge.moderationPending) buttons.push(`<button class="btn btn-primary btn-block" data-action="approve-moderation" data-challenge-id="${challenge.id}">검토 승인 후 공개</button>`);
  if (context.isOwner) {
    const canEdit = context.canEdit || (Number(challenge.teaserCount || 0) === 0 && challenge.fundingStatus === 'POSTED' && ['OPEN', 'REVIEW', 'DRAFT'].includes(challenge.status));
    if (canEdit) buttons.push(`<button class="btn btn-outline btn-block" data-action="edit-challenge" data-challenge-id="${challenge.id}">미션 수정</button>`);
    if (challenge.moderationAction === 'AUTO_REJECTED') buttons.push(`<button class="btn btn-outline btn-block" data-action="appeal-moderation" data-challenge-id="${challenge.id}">자동판정 이의신청</button>`);
    else if (context.editBlockedReason) buttons.push(`<p class="action-explanation">수정 불가: ${escapeHTML(context.editBlockedReason)}</p>`);
    if (!challenge.moderationPending && ['OPEN', 'REVIEW', 'SHORTLISTED'].includes(challenge.status)) buttons.push(`<button class="btn btn-primary btn-block" data-action="review-candidates" data-challenge-id="${challenge.id}">TEASER 후보 심사</button>`);
    if (challenge.status === 'FUNDING_REQUIRED') buttons.push(isMoneyFlowAvailable()
      ? `<button class="btn btn-primary btn-block" data-action="fund-challenge" data-challenge-id="${challenge.id}">보상금 Funding 진행</button>`
      : '<button class="btn btn-primary btn-block" disabled title="PG·지급대행 연결 후 활성화됩니다">보상금 Funding 준비중</button>');
    if (challenge.status === 'PROOF_SUBMITTED') buttons.push(`<button class="btn btn-success btn-block" data-action="confirm-success" data-challenge-id="${challenge.id}" ${isMoneyFlowAvailable() ? '' : 'disabled'}>결과 검수·완료 확정</button>`);
    if (challenge.status === 'SUCCESS') buttons.push(`<button class="btn btn-soft btn-block" data-action="view-settlement" data-challenge-id="${challenge.id}">정산내역 보기</button><button class="btn btn-outline btn-block" data-action="write-review" data-challenge-id="${challenge.id}">도전자 평가하기</button>`);
    if (!['SUCCESS', 'CANCELLED', 'DISPUTED'].includes(challenge.status) && !['FUNDED', 'PAID'].includes(challenge.fundingStatus)) buttons.push(`<button class="btn btn-ghost btn-block" data-action="cancel-challenge" data-challenge-id="${challenge.id}">미션 취소</button>`);
  } else {
    if (context.canApply) buttons.push(`<button class="btn btn-primary btn-block" data-action="submit-teaser" data-challenge-id="${challenge.id}">TEASER로 도전하기</button>`);
    if (context.viewerTeaser) {
      buttons.push(`<button type="button" class="btn btn-primary btn-block" data-action="view-my-teaser" data-challenge-id="${escapeAttribute(challenge.id)}">내 티저 보기</button>${teaserStatusBadge(context.viewerTeaser.status)}`);
      if (context.viewerTeaser.canEdit) buttons.push(`<button class="btn btn-outline btn-block" data-action="edit-teaser" data-challenge-id="${challenge.id}">TEASER 수정</button><button class="btn btn-ghost btn-block" data-action="withdraw-teaser" data-challenge-id="${challenge.id}">TEASER 철회</button>`);
    }
    if (context.isSelectedSolver && challenge.status === 'EXECUTING') buttons.push(`<button class="btn btn-success btn-block" data-action="submit-proof" data-challenge-id="${challenge.id}">수행 결과 제출</button>`);
    if (context.isSelectedSolver && challenge.status === 'SUCCESS') buttons.push(`<button class="btn btn-soft btn-block" data-action="view-settlement" data-challenge-id="${challenge.id}">정산내역 보기</button><button class="btn btn-outline btn-block" data-action="write-review" data-challenge-id="${challenge.id}">의뢰자 평가하기</button>`);
  }
  if (['FUNDED', 'EXECUTING', 'PROOF_SUBMITTED', 'SUCCESS'].includes(challenge.status) && (context.isOwner || context.isSelectedSolver)) buttons.push(`<button class="btn btn-ghost btn-block" data-action="open-dispute" data-challenge-id="${challenge.id}">분쟁·이의 제기</button>`);
  buttons.push(`<button class="btn btn-outline btn-block" data-action="share-challenge" data-challenge-id="${challenge.id}">공유하기</button>`);
  return buttons.join('');
}

function openAuthModal(mode = 'login') {
  if (mode === 'signup') {
    openModal(`<form id="signup-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">＋</span><h2>회원가입</h2><p>서비스 운영과 본인 확인에 필요한 정보만 안전하게 수집합니다.</p></div><div class="form-grid"><div class="field full"><label>활동명 <span class="required">*</span></label><input name="displayName" minlength="2" maxlength="40" required autocomplete="nickname" /><small>다른 회원과 겹치지 않는 활동명을 입력하세요.</small></div><div class="field full"><label>이름 <span class="required">*</span></label><input name="realName" minlength="2" maxlength="40" required autocomplete="name" /><small>계정 확인에 사용할 이름을 입력해주세요.</small></div><div class="field full"><label>휴대전화 <span class="required">*</span></label><input name="phone" type="tel" required autocomplete="tel" inputmode="tel" placeholder="숫자만 입력" /></div><div class="field full"><label>이메일 <span class="required">*</span></label><input name="email" type="email" required autocomplete="email" /></div><div class="field full"><label>비밀번호 <span class="required">*</span></label><input name="password" type="password" minlength="10" required autocomplete="new-password" /><small>영문과 숫자를 포함해 10자 이상</small></div><div class="field full"><label>비밀번호 확인 <span class="required">*</span></label><input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" /><small>위 비밀번호를 한 번 더 입력해주세요.</small></div><div class="field full"><label>계정유형</label><select name="accountType"><option value="individual">개인</option><option value="business">개인사업자</option><option value="corporation">법인</option><option value="organization">단체</option></select></div><div class="field full"><label>활동 지역 <span class="required">*</span></label><select name="region" required autocomplete="off"><option value="">선택</option><option>전국</option><option>서울</option><option>부산</option><option>대구</option><option>인천</option><option>광주</option><option>대전</option><option>울산</option><option>세종</option><option>경기</option><option>강원</option><option>충북</option><option>충남</option><option>전북</option><option>전남</option><option>경북</option><option>경남</option><option>제주</option><option>해외</option></select></div><div class="field full"><label>참여 목적 <span class="required">*</span></label><select name="challengeIntent" required><option value="both">미션 등록·도전 모두</option><option value="owner">미션 등록 중심</option><option value="solver">도전 참여 중심</option></select></div><div class="field"><label>출생연도 <span class="required">*</span></label><div class="birth-year-inputs" role="group" aria-label="출생연도 네 자리"><input data-birth-year-digit type="text" inputmode="numeric" pattern="[0-9]" maxlength="1" required aria-label="출생연도 첫째 자리" /><input data-birth-year-digit type="text" inputmode="numeric" pattern="[0-9]" maxlength="1" required aria-label="출생연도 둘째 자리" /><input data-birth-year-digit type="text" inputmode="numeric" pattern="[0-9]" maxlength="1" required aria-label="출생연도 셋째 자리" /><input data-birth-year-digit type="text" inputmode="numeric" pattern="[0-9]" maxlength="1" required aria-label="출생연도 넷째 자리" /></div><small>예: 1985</small></div><div class="field"><label>성별 <span class="required">*</span></label><select name="gender" required><option value="" selected disabled>선택</option><option value="female">여성</option><option value="male">남성</option></select></div><div class="field full"><label>관심·전문분야 <small>선택</small></label><textarea name="interests" maxlength="300" rows="2" placeholder="예: 마케팅, 지역문제 해결, 디자인"></textarea></div><div class="field full"><label>기관·회사명 <small>사업자·법인·단체 선택</small></label><input name="organizationName" maxlength="100" autocomplete="organization" /></div></div><label class="check-row"><input name="termsAccepted" type="checkbox" required /><span>이용약관과 운영정책에 동의합니다.</span></label><label class="check-row"><input name="privacyAccepted" type="checkbox" required /><span>개인정보처리방침에 동의합니다.</span></label><label class="check-row"><input name="marketingAccepted" type="checkbox" /><span>새 미션·운영소식 안내 수신에 동의합니다. <small>선택</small></span></label><button class="btn btn-primary btn-lg btn-block" type="submit">가입하고 이메일 인증하기</button>${renderSocialLoginButtons()}<p class="auth-switch">이미 계정이 있나요? <button type="button" data-action="login">로그인</button></p></form>`, { title: '모두의클리어 회원가입' });
    const signupForm = document.querySelector('#signup-form');
    signupForm?.elements.accountType?.closest('.field')?.remove();
    signupForm?.elements.challengeIntent?.closest('.field')?.remove();
    signupForm?.elements.organizationName?.closest('.field')?.remove();
    signupForm?.querySelector('.auth-intro p')?.replaceChildren(document.createTextNode('계정 하나로 의뢰와 수행을 모두 할 수 있습니다. 가입할 때 역할·사업자 인증을 요구하지 않습니다.'));
    enhanceSignupForm();
    return;
  }
  openModal(`<form id="login-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">◎</span><h2>로그인</h2><p>내 미션과 TRUST 이력을 확인하세요.</p></div><div class="form-grid"><div class="field full"><label>이메일 <small>회원가입 때 사용한 이메일이 아이디입니다.</small></label><input name="email" type="email" required autocomplete="email" inputmode="email" /></div><div class="field full"><label>비밀번호</label><input name="password" type="password" required autocomplete="current-password" /></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">로그인</button>${renderSocialLoginButtons()}<div class="login-help login-help-actions"><span>아이디·비밀번호를 잊으셨나요?</span><div><button type="button" data-action="find-email">이메일 찾기</button><button type="button" data-action="request-password-reset">비밀번호 찾기</button></div></div><p class="auth-switch">처음 이용하나요? <button type="button" data-action="signup">회원가입</button></p></form>`, { title: '모두의클리어 로그인' });
}

function enhanceSignupForm() {
  const form = document.querySelector('#signup-form');
  if (!(form instanceof HTMLFormElement)) return;

  const birthField = form.querySelector('[data-birth-year-digit]')?.closest('.field');
  const genderField = form.elements.gender?.closest('.field');
  if (birthField instanceof HTMLElement && genderField instanceof HTMLElement) {
    const wrapper = document.createElement('div');
    const grid = document.createElement('div');
    wrapper.className = 'field full signup-demographic-wrap';
    grid.className = 'signup-demographic-grid';
    birthField.before(wrapper);
    wrapper.append(grid);
    grid.append(birthField, genderField);
    const genderHint = document.createElement('small');
    genderHint.textContent = '필수 선택';
    genderField.append(genderHint);
  }

  const consentRows = ['termsAccepted', 'privacyAccepted', 'marketingAccepted']
    .map((name) => form.elements.namedItem(name)?.closest('.check-row'))
    .filter((row) => row instanceof HTMLLabelElement);
  if (consentRows.length !== 3) return;

  const consent = document.createElement('section');
  const allRow = document.createElement('label');
  const allInput = document.createElement('input');
  const allCopy = document.createElement('span');
  const allTitle = document.createElement('strong');
  const allHint = document.createElement('small');
  const list = document.createElement('div');
  consent.className = 'signup-consent';
  consent.setAttribute('aria-label', '약관 동의');
  allRow.className = 'check-row consent-all';
  allInput.type = 'checkbox';
  allInput.dataset.signupConsentAll = '';
  allInput.setAttribute('aria-label', '약관 전체 동의');
  allTitle.textContent = '전체 동의';
  allHint.textContent = '필수 약관 및 안내 수신 선택 항목 포함';
  allCopy.append(allTitle, allHint);
  allRow.append(allInput, allCopy);
  list.className = 'signup-consent-list';
  consentRows[0].before(consent);
  consentRows.forEach((row) => {
    const input = row.querySelector('input');
    if (input instanceof HTMLInputElement) input.dataset.signupConsentItem = '';
    list.append(row);
  });
  consent.append(allRow, list);
}

async function openSocialSignup() {
  const pending = await apiClient.oauthSignupInfo();
  openAuthModal('signup');
  const form = document.querySelector('#signup-form');
  form.id = 'oauth-signup-form';
  form.elements.email.value = pending.email;
  form.elements.email.readOnly = true;
  form.elements.displayName.value = pending.displayName;
  form.querySelectorAll('input[type="password"]').forEach((input) => input.closest('.field').remove());
  form.querySelectorAll('[data-action="oauth-login"]').forEach((button) => button.remove());
  form.querySelector('.auth-intro p').textContent = '소셜 계정을 확인했습니다. 활동 정보와 필수 동의를 입력하면 가입이 완료됩니다.';
  form.querySelector('[type="submit"]').textContent = pending.provider === 'google' ? '가입 완료하기' : '가입하고 이메일 인증하기';
}

function renderSocialLoginButtons() {
  const social = state.config?.socialLogin || {};
  if (!social.google && !social.naver) return '<p class="form-hint">Google·NAVER 로그인은 보안 설정 후 사용할 수 있습니다.</p>';
  return `<div class="form-grid"><div class="field full"><small>또는 소셜 계정으로 계속하기</small></div>${social.google ? '<button class="btn btn-outline btn-block" type="button" data-action="oauth-login" data-provider="google">Google로 계속하기</button>' : ''}${social.naver ? '<button class="btn btn-outline btn-block" type="button" data-action="oauth-login" data-provider="naver">NAVER로 계속하기</button>' : ''}</div>`;
}

async function startSocialLogin(provider) {
  const allowed = ['google', 'naver'];
  if (!allowed.includes(provider)) throw new ApiError('지원하지 않는 소셜 로그인입니다.', { code: 'OAUTH_PROVIDER_INVALID' });
  location.assign(`/api/auth/oauth/${encodeURIComponent(provider)}?returnTo=${encodeURIComponent(location.hash || '#/home')}`);
}

function openLoginHelp() {
  openModal(`<div class="password-help"><span class="auth-icon">◇</span><h3>로그인 도움</h3><p>가입 이메일을 찾거나, 가입 이메일로 비밀번호 재설정 링크를 받을 수 있습니다.</p><button class="btn btn-primary btn-block" type="button" data-action="find-email">가입 이메일 찾기</button><button class="btn btn-outline btn-block" type="button" data-action="request-password-reset">비밀번호 재설정</button><button class="btn btn-ghost btn-block" type="button" data-action="login">로그인으로 돌아가기</button></div>`, { title: '로그인 도움' });
}

function openEmailFinder() {
  openModal(`<form id="email-find-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">✉</span><h2>가입 이메일 찾기</h2><p>가입할 때 입력한 이름·활동명과 휴대전화를 확인합니다.</p></div><div class="form-grid"><div class="field full"><label>이름·활동명</label><input name="displayName" required minlength="2" maxlength="40" autocomplete="name" /></div><div class="field full"><label>휴대전화</label><input name="phone" type="tel" required inputmode="tel" autocomplete="tel" placeholder="숫자만 입력" /></div></div><p class="form-feedback" data-account-find-status hidden role="status"></p><button class="btn btn-primary btn-lg btn-block" type="submit">가입 이메일 확인</button><button class="btn btn-ghost btn-block" type="button" data-action="password-help">이전으로</button></form>`, { title: '가입 이메일 찾기' });
}

function openPasswordResetRequest() {
  openModal(`<form id="password-reset-request-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">◇</span><h2>비밀번호 재설정</h2><p>가입 이메일로 30분 동안 사용할 수 있는 재설정 링크를 보냅니다.</p></div><div class="form-grid"><div class="field full"><label>가입 이메일</label><input name="email" type="email" required autocomplete="email" inputmode="email" /></div></div><div class="notice-box"><span>✓</span><div><strong>계정 보호</strong><p>링크를 사용하면 기존 로그인은 해제됩니다.</p></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">재설정 링크 보내기</button><button class="btn btn-ghost btn-block" type="button" data-action="password-help">이전으로</button></form>`, { title: '비밀번호 재설정' });
}

function openPrimaryRecovery() {
  openModal(`<form id="primary-recovery-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">◇</span><h2>최고관리자 계정 복구</h2><p>GitHub에 보관한 복구토큰으로만 비밀번호를 새로 설정합니다.</p></div><div class="form-grid"><div class="field full"><label>최고관리자 이메일</label><input name="email" type="email" value="kpa100plus@gmail.com" required autocomplete="email" inputmode="email" /></div><div class="field full"><label>복구토큰</label><input name="recoveryToken" type="password" required autocomplete="one-time-code" /><small>GitHub Secret에 저장한 MODU_PRIMARY_RECOVERY_TOKEN 값</small></div><div class="field full"><label>새 비밀번호</label><input name="newPassword" type="password" minlength="10" required autocomplete="new-password" /><small>영문과 숫자를 포함해 10자 이상</small></div><div class="field full"><label>새 비밀번호 확인</label><input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" /></div></div><div class="notice-box"><span>✓</span><div><strong>기존 로그인은 안전하게 해제됩니다</strong><p>복구가 완료되면 즉시 최고관리자로 로그인됩니다.</p></div></div><p class="form-feedback" data-recovery-status hidden role="status"></p><button class="btn btn-primary btn-lg btn-block" type="submit">안전하게 계정 복구</button></form>`, { title: '관리자 계정 복구' });
}

function openAccountMenu() {
  openModal(`<div class="account-menu"><div class="account-summary"><span class="avatar avatar-lg ${state.user.accountType !== 'individual' ? 'avatar-company' : ''}">${initial(state.user.displayName)}</span><div><strong>${escapeHTML(state.user.displayName)}</strong><span>${escapeHTML(state.user.email)}</span><small>TRUST ${state.user.trustScore} · Strike ${state.user.strikeCount}/3</small></div></div><div class="account-actions"><button data-route="dashboard">내 클리어</button><button data-route="profile">TRUST 프로필</button><button data-action="enable-push">푸시알림 설정</button>${state.user.isAdmin ? '<button data-route="admin">관리자</button>' : ''}<button class="danger-link" data-action="logout">로그아웃</button></div></div>`, { title: '내 계정' });
}

function base64UrlToUint8Array(value) {
  const base64 = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
}

async function enablePushNotifications(button) {
  if (button) button.textContent = '연결 상태 확인 중…';
  toast('푸시알림 연결 확인 중', '기기 알림 권한과 이 기기의 수신 등록을 확인합니다.', 'info');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const message = isSamsungInternet()
      ? 'Samsung Internet에서는 웹 푸시를 받을 수 없습니다. Chrome으로 열어 홈 화면에 추가한 뒤 다시 시도하세요.'
      : 'Android는 Chrome, iPhone은 홈 화면에 설치한 앱에서 이용할 수 있습니다.';
    return toast('이 브라우저에서는 푸시 수신이 어렵습니다', message, 'warning');
  }
  const settings = await apiClient.pushSettings();
  if (!settings.configured || !settings.publicKey) return toast('푸시알림 준비 중', '알림 발송 설정이 완료되면 여기에서 켤 수 있습니다.', 'info');
  if (button) button.textContent = '알림 권한 요청 중…';
  const permission = Notification.permission === 'default' ? await Notification.requestPermission() : Notification.permission;
  if (permission !== 'granted') return toast('알림 권한이 허용되지 않았습니다', '기기 설정에서 알림을 허용한 뒤 다시 시도해주세요.', 'warning');
  const registration = await navigator.serviceWorker.ready;
  if (button) button.textContent = '수신 기기 등록 중…';
  const subscription = await registration.pushManager.getSubscription() || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64UrlToUint8Array(settings.publicKey) });
  const result = await apiClient.savePushSubscription(subscription.toJSON());
  toast(result.delivered ? '푸시알림이 켜졌습니다' : '기기 등록을 완료했습니다', result.delivered ? '확인 알림을 이 기기로 발송했습니다.' : '확인 알림 발송 결과를 확인하지 못했습니다. 기기 알림 설정을 확인해주세요.', result.delivered ? 'success' : 'warning');
  closeModal();
}

async function disablePushNotifications() {
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (subscription) {
    await apiClient.removePushSubscription(subscription.endpoint);
    await subscription.unsubscribe();
  }
  toast('푸시알림을 껐습니다', '앱 안의 알림함은 그대로 이용할 수 있습니다.', 'success');
  closeModal();
}

function openModerationNote(challengeId) {
  openModal(`<form id="moderation-note-form" data-challenge-id="${escapeAttribute(challengeId)}"><div class="notice-box"><span>◉</span><div><strong>부관리자 검토 의견</strong><p>최종 공개 승인은 최고관리자만 할 수 있습니다. 개인정보는 입력하지 마세요.</p></div></div><div class="field full"><label>검토 의견</label><textarea name="note" minlength="5" maxlength="1000" rows="5" required placeholder="확인한 위험 요소와 검토 의견을 작성하세요"></textarea></div><label class="check-row"><input name="requestApproval" type="checkbox" /><span>최고관리자에게 공개 승인 검토를 요청합니다.</span></label><button class="btn btn-primary btn-lg btn-block" type="submit">의견 저장</button></form>`, { title: '검토 의견 작성' });
}

function openChangePassword() {
  if (!state.user) return openAuthModal('login');
  openModal(`<form id="change-password-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">◇</span><h2>비밀번호 변경</h2><p>새 비밀번호는 영문과 숫자를 포함해 10자 이상 입력하세요.</p></div><div class="form-grid"><div class="field full"><label>현재 비밀번호</label><input name="currentPassword" type="password" minlength="10" required autocomplete="current-password" /></div><div class="field full"><label>새 비밀번호</label><input name="newPassword" type="password" minlength="10" required autocomplete="new-password" /></div><div class="field full"><label>새 비밀번호 확인</label><input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" /></div></div><div class="notice-box"><span>✓</span><div><strong>계정 보호</strong><p>변경이 완료되면 현재 기기를 제외한 다른 기기의 로그인이 해제됩니다.</p></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">안전하게 변경하기</button></form>`, { title: '계정 보안' });
}

function normalizeSignedInRoute() {
  if (state.user && state.route === 'simulation' && !state.user.isAdmin) {
    state.route = 'dashboard';
    history.replaceState({ ...(history.state || {}), moduModal: false }, '', '#/dashboard');
    return;
  }
  if (!state.user || !['login', 'signup', 'social-signup', 'verify-email'].includes(state.route)) return;
  state.route = 'home';
  state.emailVerification = null;
  history.replaceState({ ...(history.state || {}), moduModal: false }, '', '#/home');
}

async function completeAuthentication(user) {
  state.user = user;
  state.activity = null;
  state.trustProfile = null;
  state.adminOverview = null;
  state.routeError = null;
  closeModal({ preserveHistory: true });
  normalizeSignedInRoute();
  await loadRouteData();
  renderSystemNotice();
  render();
}

async function submitLogin(form) {
  const data = Object.fromEntries(new FormData(form));
  const options = await apiClient.loginOptions(data.email);
  const material = await createPasswordMaterial(data.password, options);
  const result = await apiClient.login({ email: data.email, passwordVerifier: material.passwordVerifier });
  await completeAuthentication(result.user);
  toast('로그인했습니다', `${state.user.displayName}님, 환영합니다.`, 'success');
}

async function submitSignup(form) {
  const data = Object.fromEntries(new FormData(form));
  const socialSignup = form.id === 'oauth-signup-form';
  if (!socialSignup && data.password !== data.confirmPassword) throw new ApiError('비밀번호 확인이 일치하지 않습니다.', { code: 'PASSWORD_CONFIRM_MISMATCH' });
  const birthYear = [...form.querySelectorAll('[data-birth-year-digit]')].map((input) => input.value).join('');
  if (!/^\d{4}$/.test(birthYear)) throw new ApiError('출생연도 네 자리를 입력해주세요.', { code: 'INVALID_BIRTH_YEAR' });
  const material = socialSignup ? {} : await createPasswordMaterial(data.password);
  const result = await (socialSignup ? apiClient.oauthSignup : apiClient.signup)({
    displayName: data.displayName,
    realName: data.realName,
    phone: data.phone,
    email: data.email,
    passwordSalt: material.passwordSalt,
    passwordVerifier: material.passwordVerifier,
    region: data.region,
    birthYear,
    gender: data.gender,
    interests: data.interests,
    termsAccepted: form.elements.termsAccepted.checked,
    privacyAccepted: form.elements.privacyAccepted.checked,
    marketingAccepted: form.elements.marketingAccepted.checked,
  });
  if (result.pendingVerification) {
    openModal(`<form id="resend-verification-form" class="auth-form"><div class="auth-intro"><span class="auth-icon">✉</span><h2>이메일 인증 필요</h2><p>${escapeHTML(result.email)} ${result.deliveryPending ? '계정이 생성되었지만 인증메일을 보내지 못했습니다. 아래 버튼으로 다시 요청해주세요.' : '주소로 인증 링크를 보냈습니다. 이메일의 확인 버튼을 누른 뒤 가입한 방법으로 로그인해주세요.'}</p></div><input name="email" type="hidden" value="${escapeAttribute(result.email)}" /><button class="btn btn-outline btn-block" type="submit">인증메일 다시 보내기</button><p class="auth-switch">${renderVerificationLogin(result.loginProvider)}</p></form>`, { title: '이메일 확인' });
    return;
  }
  await completeAuthentication(result.user);
  toast('회원가입이 완료되었습니다', '이제 미션을 만들거나 도전할 수 있습니다.', 'success');
}

function showSignupFieldError(form, error) {
  const fieldByCode = {
    EMAIL_EXISTS: 'email', INVALID_EMAIL: 'email', PHONE_EXISTS: 'phone', INVALID_PHONE: 'phone',
    DISPLAY_NAME_EXISTS: 'displayName', INVALID_NAME: 'displayName', PASSWORD_CONFIRM_MISMATCH: 'confirmPassword',
    WEAK_PASSWORD: 'password', INVALID_PASSWORD_MATERIAL: 'password', INVALID_REAL_NAME: 'realName', INVALID_REGION: 'region', INVALID_CHALLENGE_INTENT: 'challengeIntent',
    INVALID_GENDER: 'gender', INVALID_BIRTH_YEAR: 'birthYear', CONSENT_REQUIRED: 'termsAccepted',
  };
  form.querySelectorAll('.field-error').forEach((item) => item.remove());
  form.querySelectorAll('.has-error').forEach((item) => item.classList.remove('has-error'));
  form.querySelectorAll('[aria-invalid]').forEach((item) => item.removeAttribute('aria-invalid'));
  const name = fieldByCode[error.code];
  let field = name === 'birthYear' ? form.querySelector('[data-birth-year-digit]') : form.elements[name];
  if (field instanceof RadioNodeList) field = [...field].find((item) => item instanceof HTMLElement) || null;
  if (!(field instanceof HTMLElement)) field = form.querySelector('button[type="submit"]');
  const wrap = field?.closest('.field, .check-row') || field?.parentElement;
  if (wrap) {
    wrap.classList.add('has-error');
    field?.setAttribute('aria-invalid', 'true');
    const feedback = document.createElement('small');
    feedback.className = 'field-error';
    feedback.setAttribute('role', 'alert');
    feedback.textContent = error.message || '입력 내용을 확인해주세요.';
    wrap.append(feedback);
  }
  field?.focus();
  field?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  toast('회원가입 정보를 확인해주세요', error.message || '표시된 항목을 수정해주세요.', 'warning');
}

function clearFieldError(field) {
  field?.removeAttribute?.('aria-invalid');
  const wrap = field?.closest?.('.field, .check-row');
  wrap?.querySelector('.field-error')?.remove();
  wrap?.classList.remove('has-error');
}

async function submitResendVerification(form) {
  const email = new FormData(form).get('email');
  await apiClient.resendVerification(email);
  toast('인증메일을 다시 보냈습니다', '메일함과 스팸함을 확인해주세요.', 'success');
}

async function submitEmailFinder(form) {
  const data = Object.fromEntries(new FormData(form));
  const result = await apiClient.findEmail(data);
  const feedback = form.querySelector('[data-account-find-status]');
  if (!(feedback instanceof HTMLElement)) return;
  feedback.hidden = false;
  if (result.found) {
    feedback.className = 'form-feedback success';
    feedback.textContent = `가입 이메일: ${result.emailHint}`;
  } else {
    feedback.className = 'form-feedback';
    feedback.textContent = '입력한 정보와 일치하는 가입 이메일을 확인하지 못했습니다.';
  }
}

async function submitPasswordResetRequest(form) {
  const email = String(new FormData(form).get('email') || '');
  await apiClient.requestPasswordReset(email);
  openModal(`<div class="password-help"><span class="auth-icon">✉</span><h3>재설정 링크를 확인해주세요</h3><p>가입된 이메일인 경우 재설정 링크를 보냈습니다. 메일함과 스팸함을 확인해주세요.</p><button class="btn btn-primary btn-block" type="button" data-action="login">로그인으로 돌아가기</button></div>`, { title: '이메일 확인' });
}

async function submitPasswordReset(form) {
  const data = Object.fromEntries(new FormData(form));
  if (data.newPassword !== data.confirmPassword) {
    throw new ApiError('새 비밀번호 확인이 일치하지 않습니다.', { code: 'PASSWORD_CONFIRM_MISMATCH' });
  }
  const material = await createPasswordMaterial(data.newPassword);
  const result = await apiClient.resetPassword({
    token: data.token,
    passwordSalt: material.passwordSalt,
    passwordVerifier: material.passwordVerifier,
  });
  state.user = result.user;
  state.activity = null;
  state.trustProfile = null;
  state.routeError = null;
  location.hash = '#/home';
  toast('비밀번호를 변경했습니다', '기존 로그인은 안전하게 해제했습니다.', 'success');
}

async function verifyEmailFromLink() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token');
  if (!token) { state.emailVerification = { ok: false, message: '인증 링크가 없습니다.' }; return; }
  try {
    const result = await apiClient.verifyEmail(token);
    const provider = ['google', 'naver'].includes(result.loginProvider) ? result.loginProvider : 'password';
    state.emailVerification = { ok: true, provider, message: provider === 'naver' ? '이메일 인증이 완료되었습니다. NAVER로 계속하기를 눌러 로그인해주세요. 별도 비밀번호는 필요하지 않습니다.' : '이메일 인증이 완료되었습니다. 가입한 방법으로 로그인해주세요.' };
  } catch (error) {
    state.emailVerification = { ok: false, message: error instanceof ApiError ? error.message : '이메일 인증을 완료하지 못했습니다.' };
  }
}

function renderVerificationLogin(provider) {
  if (['google', 'naver'].includes(provider)) {
    return `<button type="button" class="btn btn-primary" data-action="oauth-login" data-provider="${provider}">${provider === 'naver' ? 'NAVER' : 'Google'}로 계속하기</button>`;
  }
  return '<button type="button" class="btn btn-primary" data-action="login">로그인</button>';
}

function renderEmailVerification() {
  const result = state.emailVerification;
  if (!result) return renderLoading();
  return `<section class="page-section"><div class="container">${renderEmpty(result.ok ? '이메일 인증 완료' : '이메일 인증 링크 확인 필요', result.message, `<div class="empty-actions">${renderVerificationLogin(result.provider)}<button class="btn btn-outline" data-route="home">홈으로</button></div>${!result.ok ? '<p class="form-hint">이미 인증했다면 가입한 방법으로 로그인해주세요. 인증 전이라면 로그인 화면에서 인증메일을 다시 요청할 수 있습니다.</p>' : ''}`)}</div></section>`;
}

function renderPasswordReset() {
  const token = new URLSearchParams(location.hash.split('?')[1] || '').get('token') || '';
  if (!/^[A-Za-z0-9_-]{40,200}$/.test(token)) {
    return `<section class="page-section"><div class="container">${renderEmpty('비밀번호 재설정 링크 확인 필요', '링크가 올바르지 않거나 이미 만료되었습니다. 로그인 도움에서 새 링크를 요청해주세요.', '<button class="btn btn-primary" data-action="login">로그인 도움 열기</button>')}</div></section>`;
  }
  return `<section class="page-section"><div class="container"><form id="password-reset-form" class="auth-form auth-page-form"><div class="auth-intro"><span class="auth-icon">◇</span><h1>새 비밀번호 설정</h1><p>영문과 숫자를 포함해 10자 이상으로 설정해주세요.</p></div><input name="token" type="hidden" value="${escapeAttribute(token)}" /><div class="form-grid"><div class="field full"><label>새 비밀번호</label><input name="newPassword" type="password" minlength="10" required autocomplete="new-password" /></div><div class="field full"><label>새 비밀번호 확인</label><input name="confirmPassword" type="password" minlength="10" required autocomplete="new-password" /></div></div><div class="notice-box"><span>✓</span><div><strong>계정 보호</strong><p>변경이 완료되면 현재 기기를 제외한 기존 로그인은 해제됩니다.</p></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">새 비밀번호 저장</button></form></div></section>`;
}

async function submitPrimaryRecovery(form) {
  const data = Object.fromEntries(new FormData(form));
  if (data.newPassword !== data.confirmPassword) {
    throw new ApiError('새 비밀번호 확인이 일치하지 않습니다.', { code: 'PASSWORD_CONFIRM_MISMATCH' });
  }
  const material = await createPasswordMaterial(data.newPassword);
  const result = await apiClient.recoverPrimary({
    email: data.email,
    recoveryToken: data.recoveryToken,
    passwordSalt: material.passwordSalt,
    passwordVerifier: material.passwordVerifier,
  });
  state.user = result.user;
  state.activity = null;
  state.trustProfile = null;
  closeModal();
  render();
  toast('관리자 계정을 복구했습니다', '새 비밀번호로 최고관리자 권한이 적용되었습니다.', 'success');
}

async function submitPasswordChange(form) {
  const data = Object.fromEntries(new FormData(form));
  if (data.newPassword !== data.confirmPassword) {
    throw new ApiError('새 비밀번호 확인이 일치하지 않습니다.', { code: 'PASSWORD_CONFIRM_MISMATCH' });
  }
  if (data.currentPassword === data.newPassword) {
    throw new ApiError('현재 비밀번호와 다른 비밀번호를 입력해주세요.', { code: 'PASSWORD_UNCHANGED' });
  }
  const options = await apiClient.loginOptions(state.user.email);
  const [currentMaterial, newMaterial] = await Promise.all([
    createPasswordMaterial(data.currentPassword, options),
    createPasswordMaterial(data.newPassword),
  ]);
  await apiClient.changePassword({
    currentPasswordVerifier: currentMaterial.passwordVerifier,
    newPasswordSalt: newMaterial.passwordSalt,
    newPasswordVerifier: newMaterial.passwordVerifier,
  });
  closeModal();
  toast('비밀번호를 변경했습니다', '현재 기기를 제외한 다른 로그인은 해제했습니다.', 'success');
}

async function logout() {
  let endpoint = '';
  try { const registration = await navigator.serviceWorker?.getRegistration(); endpoint = (await registration?.pushManager.getSubscription())?.endpoint || ''; } catch {}
  await apiClient.logout(endpoint);
  state.user = null;
  state.activity = null;
  state.trustProfile = null;
  state.adminOverview = null;
  state.selectedChallenge = null;
  state.simulation = null; state.simulations = []; state.simulationRole = 'owner';
  closeModal();
  navigate('home');
  toast('로그아웃했습니다', '안전하게 로그아웃되었습니다.', 'success');
}

async function submitChallenge(form) {
  if (!form.dataset.idempotencyKey) form.dataset.idempotencyKey = crypto.randomUUID();
  const data = Object.fromEntries(new FormData(form));
  const deadline = new Date(`${data.deadline}T23:59:59+09:00`).toISOString();
  const result = await apiClient.createChallenge({
    title: data.title,
    summary: data.summary,
    description: data.description,
    category: data.category,
    region: data.region,
    rewardAmount: Number(data.rewardAmount),
    successCriteria: data.successCriteria,
    paymentTrigger: data.paymentTrigger,
    evidenceRequirements: data.evidenceRequirements,
    deadline,
    visibility: data.visibility,
    subjectType: data.subjectType,
  }, form.dataset.idempotencyKey);
  if (!state.challenges.some((item) => item.id === result.challenge.id)) state.challenges.unshift(result.challenge);
  state.activity = null;
  state.createDraft = null;
  sessionStorage.removeItem('modu-challenge-create-draft');
  if (result.moderationAction === 'CHANGES_REQUIRED') toast('자동 수정요청으로 비공개 저장했습니다', '표시된 문장을 고쳐 저장하면 즉시 다시 자동 검수합니다.', 'warning');
  else if (result.moderationAction === 'AUTO_REJECTED') toast('금지·고위험 항목으로 자동 거절했습니다', '원본은 비공개 보관되며 오탐이면 이의신청할 수 있습니다.', 'warning');
  else toast('자동 검수 후 미션이 공개되었습니다', '판정·위험도·정책 버전·감사 기록이 저장되었습니다.', 'success');
  navigate('dashboard');
}

function openTeaserForm(challengeId) {
  const challenge = state.selectedChallenge?.challenge || state.challenges.find((item) => item.id === challengeId);
  openModal(`<form id="teaser-form" data-challenge-id="${challengeId}"><div class="notice-box"><span>◉</span><div><strong>TEASER는 해결 가능성의 예고편입니다</strong><p>개인정보·회사명·영업비밀은 가리고, 의뢰자가 가능성을 판단할 수준만 제출하세요.</p></div></div><button class="btn btn-soft btn-lg btn-block teaser-template-button" type="button" data-action="fill-teaser-template" data-challenge-id="${challengeId}">✦ 이 미션에 맞춰 자동 양식 채우기</button><p class="form-hint teaser-template-hint">초안이 자동 입력됩니다. 실제 경험과 방법에 맞게 꼭 수정한 뒤 제출하세요.</p><div class="form-guide"><strong>작성 기준</strong><span>한 줄 제안 5자 이상 · 해결능력 20자 이상 · 접근방법 20자 이상</span></div><div class="form-grid"><div class="field full"><label>한 줄 제안 <small>5~100자</small></label><input name="headline" required minlength="5" maxlength="100" placeholder="예: 지역 배송 운영 경험으로 실행안을 제안합니다" data-count /></div><div class="field full"><label>해결능력·경험 <small>20자 이상</small></label><textarea name="capability" required minlength="20" maxlength="1200" rows="4" placeholder="관련 경험, 실적, 가능한 역할을 구체적으로 적어주세요" data-count></textarea></div><div class="field full"><label>접근방법 <small>20자 이상</small></label><textarea name="approach" required minlength="20" maxlength="1600" rows="4" placeholder="어떤 순서와 방법으로 해결할지 적어주세요" data-count></textarea></div><div class="field"><label>예상기간(일)</label><input name="expectedDays" type="number" min="1" max="365" required value="7" /></div><div class="field"><label>자격 유형</label><input name="qualificationType" maxlength="80" placeholder="필요한 경우만" /></div><div class="field full"><label>마스킹 증빙</label><textarea name="maskedEvidence" maxlength="1000" rows="3" placeholder="실명·연락처·회사명을 가린 증빙"></textarea></div><div class="field full"><label>자격 참조정보</label><input name="qualificationRef" maxlength="160" placeholder="공식 확인 가능한 정보만" /></div></div><label class="check-row"><input type="checkbox" required /><span>허위정보와 타인의 개인정보를 제출하지 않겠습니다.</span></label><button class="btn btn-primary btn-lg btn-block" type="submit">TEASER 제출</button></form>`, { title: escapeHTML(challenge?.title || 'TEASER 제출'), wide: true });
  const teaserForm = document.querySelector('#teaser-form');
  teaserForm?.querySelector('.notice-box')?.insertAdjacentHTML('afterend', `<div class="field full activity-subject-field"><label>이번 수행 활동 주체</label><select name="subjectType" required><option value="individual">개인</option><option value="business">개인사업자</option><option value="corporation">법인</option><option value="organization">단체</option></select><small>보유한 유효 인증은 의뢰·수행 활동에 공통으로 재사용합니다.</small></div>`);
  restoreTransientModalDraft(teaserForm);
}

function fillTeaserTemplate(challengeId) {
  const form = document.querySelector('#teaser-form');
  const challenge = state.selectedChallenge?.challenge || state.challenges.find((item) => item.id === challengeId);
  if (!form || !challenge) return;
  const topic = String(challenge.title || '이 미션').replace(/^\[.*?\]\s*/, '');
  form.elements.headline.value = `${topic}에 맞는 실행안을 제안합니다`;
  form.elements.capability.value = `이 미션과 관련된 경험과 역할을 바탕으로 조건을 확인한 뒤 실행 가능한 방법을 제안하겠습니다. 실제 수행 가능한 범위와 일정은 제출 전 정확히 수정해 안내하겠습니다.`;
  form.elements.approach.value = `요청 내용을 먼저 확인하고 필요한 조건을 정리한 뒤, 실행 순서와 예상 일정을 제안하겠습니다. 진행 과정과 결과는 개인정보를 제외한 확인 가능한 자료로 공유하겠습니다.`;
  form.elements.expectedDays.value = '7';
  form.querySelectorAll('[data-count]').forEach(updateFieldCounter);
  toast('자동 양식 초안을 채웠습니다', '실제 경험·수행 방법에 맞게 내용을 수정하세요.', 'success');
}

async function submitTeaser(form) {
  const challengeId = form.dataset.challengeId;
  const data = Object.fromEntries(new FormData(form));
  await apiClient.submitTeaser(challengeId, { ...data, subjectType: data.subjectType, expectedDays: Number(data.expectedDays) });
  sessionStorage.removeItem(transientModalDraftKey(form));
  closeModal();
  state.activity = null;
  await loadChallenges();
  toast('TEASER를 제출했습니다', '의뢰자가 해결 가능성과 TRUST 이력을 검토합니다.', 'success');
  await openChallenge(challengeId);
}

async function openTeaserEditForm(challengeId) {
  state.selectedChallenge = await apiClient.getChallenge(challengeId);
  const teaser = state.selectedChallenge?.context?.viewerTeaser;
  if (!teaser?.canEdit) return toast('현재 수정할 수 없습니다', '후보 선정 전 TEASER만 수정할 수 있습니다.', 'warning');
  openModal(`<form id="teaser-edit-form" data-challenge-id="${challengeId}" data-teaser-id="${teaser.id}"><div class="notice-box"><span>✎</span><div><strong>제출한 TEASER 수정</strong><p>후보 선정이 시작되기 전까지만 수정할 수 있습니다.</p></div></div><div class="form-grid" style="margin-top:18px"><div class="field full"><label>한 줄 제안 <small>5~100자</small></label><input name="headline" required minlength="5" maxlength="100" value="${escapeAttribute(teaser.headline || '')}" /></div><div class="field full"><label>해결능력·경험 <small>20자 이상</small></label><textarea name="capability" required minlength="20" maxlength="1200" rows="4">${escapeHTML(teaser.capability || '')}</textarea></div><div class="field full"><label>접근방법 <small>20자 이상</small></label><textarea name="approach" required minlength="20" maxlength="1600" rows="4">${escapeHTML(teaser.approach || '')}</textarea></div><div class="field"><label>예상기간(일)</label><input name="expectedDays" type="number" min="1" max="365" required value="${Number(teaser.expectedDays || 7)}" /></div><div class="field"><label>자격 유형</label><input name="qualificationType" maxlength="80" value="${escapeAttribute(teaser.qualificationType || '')}" /></div><div class="field full"><label>마스킹 증빙</label><textarea name="maskedEvidence" maxlength="1000" rows="3">${escapeHTML(teaser.maskedEvidence || '')}</textarea></div><div class="field full"><label>자격 참조정보</label><input name="qualificationRef" maxlength="160" value="${escapeAttribute(teaser.qualificationRef || '')}" /></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">수정 내용 저장</button></form>`, { title: 'TEASER 수정', wide: true });
}

async function submitTeaserEdit(form) {
  const data = Object.fromEntries(new FormData(form));
  data.expectedDays = Number(data.expectedDays);
  await apiClient.updateTeaser(form.dataset.challengeId, form.dataset.teaserId, data);
  toast('TEASER를 수정했습니다', '수정 내용이 정상 반영되었습니다.', 'success');
  await openChallenge(form.dataset.challengeId);
}

function openTeaserWithdrawForm(challengeId) {
  const teaser = state.selectedChallenge?.context?.viewerTeaser;
  if (!teaser?.canEdit) return toast('현재 철회할 수 없습니다', '후보 선정 전 TEASER만 철회할 수 있습니다.', 'warning');
  openModal(`<form id="teaser-withdraw-form" data-challenge-id="${challengeId}" data-teaser-id="${teaser.id}"><div class="notice-box warning"><span>!</span><div><strong>제출한 TEASER를 철회할까요?</strong><p>기록은 보존되며, 철회 후 이 미션에 다시 도전할 수 있습니다.</p></div></div><button class="btn btn-danger btn-block" type="submit" style="margin-top:18px">TEASER 철회 확인</button></form>`, { title: 'TEASER 철회' });
}

async function submitTeaserWithdraw(form) {
  await apiClient.withdrawTeaser(form.dataset.challengeId, form.dataset.teaserId);
  state.activity = null;
  toast('TEASER를 철회했습니다', '철회 이력은 안전하게 보존됩니다.', 'success');
  await loadChallenges();
  await openChallenge(form.dataset.challengeId);
}

async function openCandidateReview(challengeId) {
  openModal(renderModalLoading(), { title: 'TEASER 후보 심사', wide: true });
  try {
    const result = await apiClient.listTeasers(challengeId);
    const teasers = result.teasers || [];
    openModal(`<div class="candidate-review"><div class="notice-box"><span>✓</span><div><strong>수행자 후보는 한 번에 1명만 선택됩니다</strong><p>다른 제안을 후보로 선택하면 이전 후보는 자동 해제됩니다. 실제 수행 확정과 보상금 확보는 별도 단계입니다.</p>${!isMoneyFlowAvailable() ? '<p class="workflow-blocked">현재 결제·지급 연동 준비 중으로 최종 수행자 확정 이후 단계는 아직 이용할 수 없습니다. 후보선정과 제출 내용 확인은 가능합니다.</p>' : ''}</div></div><div class="candidate-grid">${teasers.length ? teasers.map((teaser) => renderCandidateCard(challengeId, teaser)).join('') : renderEmpty('제출된 TEASER가 없습니다', '참가자가 제출하면 이곳에서 비교할 수 있습니다.')}</div><button type="button" class="btn btn-outline btn-block" data-challenge-id="${escapeAttribute(challengeId)}">미션 진행상황으로 돌아가기</button></div>`, { title: `제안 ${teasers.length}명`, wide: true });
  } catch (error) {
    renderModalRequestError('TEASER 후보 심사', error, 'retry-candidate-review', { challengeId });
    showError(error);
  }
}

function renderCandidateCard(challengeId, teaser) {
  const finalistAvailable = isMoneyFlowAvailable();
  const finalistDisabled = ['SELECTED', 'WITHDRAWN', 'REJECTED'].includes(teaser.status) || !finalistAvailable;
  const finalistLabel = teaser.status === 'SELECTED' ? '최종 수행자 확정 완료' : finalistAvailable ? '최종 수행자 확정' : '최종 확정 · 준비 중';
  return `<article class="candidate-card ${teaser.status === 'SELECTED' ? 'selected' : ''}"><div class="candidate-head"><button class="profile-trigger" type="button" data-action="view-public-profile" data-user-id="${escapeAttribute(teaser.solverId || '')}"><span class="avatar">${initial(teaser.solver?.displayName)}</span><span><strong>${escapeHTML(teaser.solver?.displayName || '도전자')}</strong><small>도전자 · Strike ${teaser.solver?.strikes ?? 0}/3</small></span></button>${teaserStatusBadge(teaser.status)}</div>${renderTrustGauge(teaser.solver?.trustScore, { detailed: true, userId: teaser.solverId })}<h3>${escapeHTML(teaser.headline)}</h3><div class="candidate-detail"><strong>해결능력</strong><p>${nl2br(teaser.capability)}</p><strong>접근방법</strong><p>${nl2br(teaser.approach)}</p><strong>예상기간</strong><p>${teaser.expectedDays}일</p>${teaser.maskedEvidence ? `<strong>마스킹 증빙</strong><p>${nl2br(teaser.maskedEvidence)}</p>` : ''}</div><div class="verify-row">${verifyBadge('본인', teaser.solver?.identityVerified)}${verifyBadge('사업자', teaser.solver?.businessVerified)}${verifyBadge('전문자격', teaser.solver?.professionalVerified)}</div><div class="candidate-actions"><button class="btn btn-outline" data-action="shortlist" data-challenge-id="${challengeId}" data-teaser-id="${teaser.id}" ${['SHORTLISTED','SELECTED','WITHDRAWN','REJECTED'].includes(teaser.status) ? 'disabled' : ''}>${['SHORTLISTED','SELECTED'].includes(teaser.status) ? '✓ 현재 수행자 후보' : '수행자 후보로 선택'}</button><button class="btn btn-primary" data-action="select-finalist" data-challenge-id="${challengeId}" data-teaser-id="${teaser.id}" ${finalistDisabled ? 'disabled' : ''} title="${finalistAvailable ? '' : 'PG·지급대행 연결 후 활성화됩니다'}">${finalistLabel}</button></div></article>`;
}

async function shortlistCandidate(challengeId, teaserId, mode) {
  await apiClient.shortlist(challengeId, teaserId, mode);
  state.activity = null;
  await loadChallenges();
  toast(mode === 'select' ? '최종 수행자를 확정했습니다' : '수행자 후보를 선택했습니다', mode === 'select' ? '의뢰자의 보상금 확보 단계로 이동합니다.' : '기존 후보가 있었다면 자동 해제되었습니다. 실제 수행 확정은 별도입니다.', 'success');
  if (mode === 'select') return openChallenge(challengeId);
  await openCandidateReview(challengeId);
}

async function loadPublicTrustProfile(userId) {
  if (!userId) throw new Error('프로필 식별정보가 없습니다.');
  const result = await apiClient.trust(userId);
  return result.profile;
}

async function openPublicProfile(userId) {
  openModal(renderModalLoading(), { title: '공개 프로필', wide: true });
  try {
    const profile = await loadPublicTrustProfile(userId);
    const owner = profile.ownerStats || {};
    const solver = profile.solverStats || {};
    const reviews = profile.recentReviews || [];
    openModal(`<div class="public-profile"><section class="public-profile-hero"><span class="avatar avatar-xl ${profile.accountType !== 'individual' ? 'avatar-company' : ''}">${initial(profile.displayName)}</span><div><span class="eyebrow">PUBLIC PROFILE</span><h2>${escapeHTML(profile.displayName)}</h2><p>${accountTypeLabel(profile.accountType)} · ${formatDate(profile.createdAt)}부터 활동</p><div class="verify-row">${verifyBadge('본인', profile.verification?.identity)}${verifyBadge('사업자', profile.verification?.business)}${verifyBadge('전문자격', profile.verification?.professional)}</div></div></section>${renderTrustGauge(profile.trustScore, { detailed: true, userId: profile.id })}<div class="profile-stat-grid"><article><span>개설 미션</span><strong>${Number(owner.opened || 0).toLocaleString('ko-KR')}</strong><small>성공 ${Number(owner.completed || 0)}건</small></article><article><span>참여 TEASER</span><strong>${Number(solver.teasers || 0).toLocaleString('ko-KR')}</strong><small>성공 ${Number(solver.successes || 0)}건</small></article><article><span>누적 지급·수익</span><strong>${formatCompactWon(Number(owner.total_paid || 0) + Number(solver.earned || 0))}</strong><small>공개 운영 실적</small></article><article><span>함께할 의향</span><strong>${Number(profile.reviewStats?.work_again_rate || 0)}%</strong><small>리뷰 ${Number(profile.reviewStats?.review_count || 0)}건</small></article></div><section class="profile-review-section"><h3>최근 공개 리뷰</h3>${reviews.length ? reviews.map((review) => `<article class="review-item"><div class="review-item-head"><span class="stars">${stars(Number(review.rating))}</span><small>${formatDate(review.created_at)}</small></div><p>${escapeHTML(review.comment || '평점이 등록되었습니다.')}</p></article>`).join('') : '<p class="muted-copy">아직 공개 리뷰가 없습니다.</p>'}</section><p class="privacy-note">연락처·이메일 등 개인정보는 공개하지 않습니다.</p></div>`, { title: '공개 프로필', wide: true });
  } catch (error) { closeModal(); showError(error); }
}

async function openAdminMemberDetail(userId) {
  openModal(renderModalLoading(), { title: '회원 가입정보', wide: true });
  try {
    const { member } = await apiClient.adminMemberDetail(userId);
    const verification = member.verification || {};
    const consent = member.consent || {};
    const registration = member.registration || {};
    openModal(`<div class="admin-member-detail"><section class="public-profile-hero"><span class="avatar avatar-xl ${member.accountType !== 'individual' ? 'avatar-company' : ''}">${initial(member.displayName)}</span><div><span class="eyebrow">PRIMARY ADMIN ONLY</span><h2>${escapeHTML(member.displayName)}</h2><p>${accountTypeLabel(member.accountType)} · 가입 ${formatDateTime(member.createdAt)}</p><div class="verify-row">${verifyBadge('본인', verification.identity)}${verifyBadge('사업자', verification.business)}${verifyBadge('전문자격', verification.professional)}${verifyBadge('이메일', verification.email)}</div></div></section><div class="notice-box warning"><span>!</span><div><strong>최고관리자 전용 정보</strong><p>회원가입·동의 처리 확인을 위한 정보이며, 이번 조회는 Audit Log에 기록됩니다. 비밀번호와 세션 정보는 표시하지 않습니다.</p></div></div><section class="dashboard-card"><div class="dashboard-card-head"><h3>가입 계정</h3><strong>${escapeHTML(member.status)}</strong></div><div class="preview-list"><div class="preview-row"><span>이름·활동명</span><strong>${escapeHTML(member.displayName)}</strong></div><div class="preview-row"><span>가입 이메일</span><strong>${escapeHTML(member.email)}</strong></div><div class="preview-row"><span>계정유형</span><strong>${accountTypeLabel(member.accountType)}</strong></div><div class="preview-row"><span>가입 일시</span><strong>${formatDateTime(member.createdAt)}</strong></div><div class="preview-row"><span>최근 변경</span><strong>${formatDateTime(member.updatedAt)}</strong></div></div></section><section class="dashboard-card"><div class="dashboard-card-head"><h3>가입 추가정보</h3><strong>${escapeHTML(registration.source || 'password')}</strong></div><div class="preview-list"><div class="preview-row"><span>휴대전화</span><strong>${escapeHTML(registration.phone || '기존 회원')}</strong></div><div class="preview-row"><span>활동 지역</span><strong>${escapeHTML(registration.region || '-')}</strong></div><div class="preview-row"><span>참여 목적</span><strong>${({ owner:'개설 중심', solver:'도전 중심', both:'개설·도전 모두' })[registration.challengeIntent] || '-'}</strong></div><div class="preview-row"><span>출생연도·성별</span><strong>${escapeHTML(registration.birthYear || '-')} · ${({ female:'여성', male:'남성', other:'기타', prefer_not:'응답 안 함' })[registration.gender] || '-'}</strong></div><div class="preview-row"><span>기관·회사명</span><strong>${escapeHTML(registration.organizationName || '-')}</strong></div><div class="preview-row"><span>관심·전문분야</span><strong>${escapeHTML(registration.interests || '-')}</strong></div><div class="preview-row"><span>마케팅 수신</span><strong>${registration.marketingAccepted ? `동의 · ${formatDateTime(registration.marketingAcceptedAt)}` : '미동의'}</strong></div><div class="preview-row"><span>최근 로그인</span><strong>${formatDateTime(registration.lastLoginAt)}</strong></div></div></section><section class="dashboard-card"><div class="dashboard-card-head"><h3>동의 기록</h3><strong>보관됨</strong></div><div class="preview-list"><div class="preview-row"><span>이용약관</span><strong>${escapeHTML(consent.termsVersion || '기록 없음')} · ${formatDateTime(consent.termsAcceptedAt)}</strong></div><div class="preview-row"><span>개인정보처리방침</span><strong>${escapeHTML(consent.privacyVersion || '기록 없음')} · ${formatDateTime(consent.privacyAcceptedAt)}</strong></div></div></section><section class="dashboard-card"><div class="dashboard-card-head"><h3>운영 상태</h3><strong>TRUST ${Number(member.trustScore || 0)}</strong></div><div class="preview-list"><div class="preview-row"><span>Strike</span><strong>${Number(member.strikeCount || 0)}/3</strong></div><div class="preview-row"><span>보상금 표시한도</span><strong>${formatWon(member.bountyLimit)}</strong></div><div class="preview-row"><span>관리자 구분</span><strong>${member.adminRole === 'primary' ? '최고관리자' : member.adminRole === 'deputy' ? '부관리자' : '일반회원'}</strong></div></div></section></div>`, { title: '회원 가입정보', wide: true });
    if (member.adminRole === 'member' && member.status !== 'closed') {
      document.querySelector('.admin-member-detail .dashboard-card:last-child')?.insertAdjacentHTML('beforeend', `<button class="btn btn-outline btn-block" type="button" data-action="open-member-status" data-user-id="${escapeAttribute(member.id)}" data-current-status="${escapeAttribute(member.status)}">계정 상태 변경</button>`);
    }
  } catch (error) { closeModal(); showError(error); }
}

function openAdminMemberStatus(userId, currentStatus) {
  openModal(`<form id="admin-member-status-form" data-user-id="${escapeAttribute(userId)}"><div class="notice-box warning"><span>!</span><div><strong>상태 변경은 즉시 적용됩니다</strong><p>정지하면 기존 세션도 종료됩니다. 모든 변경은 회원 알림과 Audit Log에 남습니다.</p></div></div><div class="field" style="margin-top:18px"><label>변경 상태</label><select name="status" required><option value="active" ${currentStatus === 'active' ? 'selected' : ''}>정상</option><option value="limited" ${currentStatus === 'limited' ? 'selected' : ''}>일부 제한</option><option value="suspended" ${currentStatus === 'suspended' ? 'selected' : ''}>이용 정지</option></select></div><div class="field"><label>운영 사유 <small>10자 이상</small></label><textarea name="reason" required minlength="10" maxlength="1000" rows="5" placeholder="확인한 사실과 조치 사유를 구체적으로 기록하세요."></textarea></div><button class="btn btn-primary btn-block" type="submit">상태 변경 및 기록</button></form>`, { title: '회원 계정 상태 변경' });
}

async function submitAdminMemberStatus(form) {
  const data = new FormData(form);
  const status = String(data.get('status') || '');
  if (!window.confirm(`회원 계정 상태를 ${status} 상태로 변경할까요?`)) return;
  await apiClient.updateAdminMemberStatus(form.dataset.userId, { status, reason: String(data.get('reason') || '') });
  closeModal();
  state.adminOverview = (await apiClient.adminOverview()).overview;
  render();
  toast('계정 상태를 변경했습니다', '회원 알림과 관리자 감사 기록에 반영했습니다.', 'success');
}

async function openAdminDispute(disputeId) {
  openModal(renderModalLoading(), { title: '분쟁 처리', wide: true });
  try {
    const { dispute } = await apiClient.adminDisputeDetail(disputeId);
    openModal(`<form id="admin-dispute-status-form" data-dispute-id="${escapeAttribute(dispute.id)}"><div class="notice-box warning"><span>!</span><div><strong>실제 결제·지급은 실행하지 않습니다</strong><p>처리 단계·미션 상태·당사자 알림·Audit Log만 갱신합니다. 종결 결과는 충분한 증빙 확인 후 선택하세요.</p></div></div><section class="dashboard-card" style="margin-top:18px"><div class="dashboard-card-head"><h3>${escapeHTML(dispute.title)}</h3><strong>${escapeHTML(dispute.status)}</strong></div><div class="preview-list"><div class="preview-row"><span>신청인</span><strong>${escapeHTML(dispute.openedByName || '-')}</strong></div><div class="preview-row"><span>상대방</span><strong>${escapeHTML(dispute.respondentName || '-')}</strong></div><div class="preview-row"><span>분쟁 유형</span><strong>${escapeHTML(dispute.reasonCode)}</strong></div><div class="preview-row"><span>미션 상태</span><strong>${escapeHTML(dispute.challengeStatus)}</strong></div></div><p>${nl2br(dispute.description)}</p></section><div class="form-grid"><div class="field"><label>처리 단계</label><select name="status" required><option value="EVIDENCE">증빙 확인</option><option value="MEDIATION">조정 중</option><option value="DECIDED">판정 완료</option><option value="CLOSED">종결</option></select></div><div class="field"><label>종결 시 미션 결과</label><select name="outcome"><option value="">중간 단계에서는 선택 안 함</option><option value="RESTORE">분쟁 전 단계로 복구</option><option value="CANCELLED">미션 취소</option><option value="FAILED">미션 실패</option><option value="SUCCESS">미션 성공</option></select></div><div class="field full"><label>처리 내용 <small>10자 이상</small></label><textarea name="resolution" required minlength="10" maxlength="2000" rows="7" placeholder="확인한 증빙, 판단 근거, 다음 조치를 기록하세요."></textarea></div></div><button class="btn btn-primary btn-block" type="submit">처리 단계 저장</button></form>`, { title: '분쟁 처리', wide: true });
  } catch (error) { closeModal(); showError(error); }
}

async function submitAdminDisputeStatus(form) {
  const data = new FormData(form);
  const status = String(data.get('status') || '');
  const outcome = String(data.get('outcome') || '');
  if (['DECIDED', 'CLOSED'].includes(status) && !outcome) throw new ApiError('종결할 때는 미션 처리 결과를 선택해주세요.', { code: 'DISPUTE_OUTCOME_REQUIRED' });
  if (!window.confirm('입력한 분쟁 처리 내용을 저장하고 당사자에게 알릴까요?')) return;
  const result = await apiClient.updateAdminDisputeStatus(form.dataset.disputeId, { status, outcome, resolution: String(data.get('resolution') || '') });
  closeModal();
  state.adminOverview = (await apiClient.adminOverview()).overview;
  render();
  toast('분쟁 처리 내용을 저장했습니다', result.moneyTransferred === false ? '실제 결제·지급 없이 상태·알림·감사 기록만 반영했습니다.' : '처리 결과를 반영했습니다.', 'success');
}

async function openTrustHistory(userId) {
  openModal(renderModalLoading(), { title: '클리어 신뢰내역', wide: true });
  try {
    const profile = await loadPublicTrustProfile(userId);
    const events = profile.trustHistory || [];
    openModal(`<div class="trust-history"><section class="trust-history-hero"><div><span class="eyebrow">클리어 신뢰도</span><h2>${escapeHTML(profile.displayName)}님의 신뢰도</h2><p>검증·이행·상호평가·운영제재를 근거로 관리됩니다.</p></div>${renderTrustGauge(profile.trustScore, { detailed: true })}</section><div class="trust-factor-grid"><article><span>신원 검증</span><strong>${profile.verification?.identity ? '완료' : '미확인'}</strong></article><article><span>성공 수행</span><strong>${Number(profile.solverStats?.successes || 0)}건</strong></article><article><span>평균 리뷰</span><strong>${Number(profile.reviewStats?.average_rating || 0).toFixed(1)}</strong></article><article><span>활성 Strike</span><strong>${Number(profile.strikeCount || 0)}/3</strong></article></div><section class="trust-timeline"><h3>최근 신뢰내역</h3>${events.length ? events.map((event) => `<article><i class="${Number(event.delta || 0) < 0 ? 'negative' : 'positive'}">${event.delta === null || event.delta === undefined ? '•' : Number(event.delta) > 0 ? `+${event.delta}` : event.delta}</i><div><strong>${escapeHTML(event.title)}</strong><p>${escapeHTML(event.description || '')}</p><small>${formatDate(event.date)}</small></div></article>`).join('') : '<p class="muted-copy">아직 공개할 신뢰 변동 내역이 없습니다.</p>'}</section><div class="trust-guide"><strong>점수 구간</strong><span><b class="prime">90+</b> 최고 신뢰</span><span><b class="trusted">80+</b> 신뢰</span><span><b class="steady">65+</b> 안정</span><span><b class="growing">45+</b> 성장 중</span><span><b class="caution">0+</b> 주의 필요</span></div><p class="privacy-note">분쟁 상세, 신고자, 개인정보는 공개하지 않습니다.</p></div>`, { title: '클리어 신뢰내역', wide: true });
  } catch (error) { closeModal(); showError(error); }
}

function openFundingModal(challengeId) {
  const challenge = state.selectedChallenge?.challenge;
  const settlement = calculateSettlement(challenge?.rewardAmount || 0, challenge?.feeRate || state.config?.feeRate || 0.1);
  const localSimulation = isLocalMoneySimulation();
  openModal(`<div class="funding-panel"><div class="funding-amount"><small>Funding 대상 보상금</small><strong>${formatWon(challenge?.rewardAmount)}</strong></div><div class="preview-list"><div class="preview-row"><span>성공자 예상 지급</span><strong>${formatWon(settlement.solverPayout)}</strong></div><div class="preview-row"><span>플랫폼 이용수수료</span><strong>${formatWon(settlement.platformFee)}</strong></div><div class="preview-row"><span>Funding 기한</span><strong>${formatDateTime(challenge?.paymentDueAt)}</strong></div></div>${state.config?.moneyEnabled ? '<div class="notice-box"><span>₩</span><div><strong>결제 제공사 연결 대기</strong><p>승인된 PG 결제창으로 이동하도록 연결합니다.</p></div></div>' : '<div class="notice-box warning"><span>!</span><div><strong>실제 결제는 아직 비활성입니다</strong><p>PG·지급대행 승인 전 실제 돈을 받지 않습니다.</p></div></div>'}${localSimulation ? `<button class="btn btn-primary btn-lg btn-block" data-action="confirm-staging-funding" data-challenge-id="${challengeId}">로컬 검증 Funding 확인</button>` : '<button class="btn btn-primary btn-lg btn-block" disabled>PG 연결 후 활성화</button>'}</div>`, { title: '보상금 Funding' });
}

async function confirmStagingFunding(challengeId) {
  await apiClient.confirmFunding(challengeId, { provider: 'manual-preview', providerReference: `stage_${Date.now()}` });
  state.activity = null;
  await loadChallenges();
  toast('Funding 상태가 확인되었습니다', '로컬 검증용이며 실제 금전결제는 발생하지 않았습니다.', 'success');
  await openChallenge(challengeId);
}

function openProofForm(challengeId) {
  openModal(`<form id="proof-form" data-challenge-id="${challengeId}"><div class="notice-box"><span>▤</span><div><strong>사전에 공개된 성공조건과 증빙기준에 맞춰 제출하세요</strong><p>제출시각과 내용 해시가 운영기록에 남습니다.</p></div></div><div class="form-grid" style="margin-top:18px"><div class="field full"><label>수행 결과</label><textarea name="description" required minlength="20" maxlength="3000" rows="8"></textarea></div><div class="field full"><label>증빙 URL</label><input name="evidenceUrl" type="url" maxlength="1000" placeholder="https://" /></div></div><button class="btn btn-success btn-lg btn-block" type="submit">결과 제출</button></form>`, { title: '수행 결과·증빙 제출', wide: true });
}

async function submitProof(form) {
  const challengeId = form.dataset.challengeId;
  const data = Object.fromEntries(new FormData(form));
  await apiClient.submitProof(challengeId, data);
  closeModal();
  state.activity = null;
  await loadChallenges();
  toast('결과 증빙을 제출했습니다', '의뢰자가 성공조건 충족 여부를 확인합니다.', 'success');
  await openChallenge(challengeId);
}

function openSuccessConfirm(challengeId) {
  const challenge = state.selectedChallenge?.challenge;
  openModal(`<div class="confirm-panel"><div class="confirm-icon">✓</div><h3>클리어 성공을 확정하시겠습니까?</h3><p>사전에 공개한 성공조건과 제출 증빙을 확인한 뒤 확정하세요. 확정 후 정산 절차가 시작됩니다.</p><div class="preview-list"><div class="preview-row"><span>보상금</span><strong>${formatWon(challenge?.rewardAmount)}</strong></div><div class="preview-row"><span>성공조건</span><strong class="wrap">${escapeHTML(challenge?.successCriteria || '')}</strong></div></div></div>`, { title: '성공 확정', footer: `<button class="btn btn-outline" data-action="close-modal">취소</button><button class="btn btn-success" data-action="do-confirm-success" data-challenge-id="${challengeId}">성공 확정</button>` });
}

async function confirmSuccess(challengeId) {
  const result = await apiClient.confirmSuccess(challengeId);
  state.activity = null;
  await loadChallenges();
  toast('클리어 성공이 확정되었습니다', `성공자 지급예정액 ${formatWon(result.settlement?.solverPayout)}`, 'success');
  await openChallenge(challengeId);
}

function openSettlement() {
  const settlement = state.selectedChallenge?.context?.settlement;
  if (!settlement) return toast('정산정보가 없습니다', 'Funding 이후 정산정보가 생성됩니다.', 'warning');
  openModal(`<div class="settlement-receipt"><div class="receipt-success">✓</div><h2>${settlement.status === 'PAID' ? '보상금 지급 완료' : '정산 처리 중'}</h2><div class="receipt-total"><small>최종 지급 예정액</small><strong>${formatWon(settlement.solver_payout ?? settlement.solverPayout)}</strong></div><details><summary>정산 상세보기</summary><div class="preview-list"><div class="preview-row"><span>표시 보상금</span><strong>${formatWon(settlement.gross_reward ?? settlement.grossReward)}</strong></div><div class="preview-row"><span>플랫폼 이용수수료</span><strong>${formatWon(settlement.platform_fee ?? settlement.platformFee)}</strong></div><div class="preview-row"><span>지급 상태</span><strong>${escapeHTML(settlement.status)}</strong></div></div></details></div>`, { title: '정산내역' });
}

function openReviewForm(challengeId) {
  openModal(`<form id="review-form" data-challenge-id="${challengeId}"><div class="form-grid"><div class="field"><label>종합평가</label><select name="rating">${[5,4,3,2,1].map((n) => `<option value="${n}">${n}점 · ${stars(n)}</option>`).join('')}</select></div><div class="field"><label>정확성</label><input name="accuracy" type="number" min="1" max="5" value="5" /></div><div class="field"><label>응답속도</label><input name="responsiveness" type="number" min="1" max="5" value="5" /></div><div class="field"><label>약속이행</label><input name="reliability" type="number" min="1" max="5" value="5" /></div><div class="field full"><label>리뷰</label><textarea name="comment" maxlength="500" rows="5"></textarea></div></div><label class="check-row"><input name="wouldWorkAgain" type="checkbox" checked /><span>다시 함께하고 싶습니다.</span></label><button class="btn btn-primary btn-block" type="submit">리뷰 등록</button></form>`, { title: '상호 리뷰' });
}

async function submitReview(form) {
  const challengeId = form.dataset.challengeId;
  const data = Object.fromEntries(new FormData(form));
  await apiClient.createReview(challengeId, { rating: Number(data.rating), accuracy: Number(data.accuracy), responsiveness: Number(data.responsiveness), reliability: Number(data.reliability), wouldWorkAgain: form.elements.wouldWorkAgain.checked, comment: data.comment });
  closeModal();
  state.trustProfile = null;
  toast('리뷰를 등록했습니다', '실제 거래 이력과 함께 TRUST에 반영됩니다.', 'success');
}

function openCancelForm(challengeId) {
  openModal(`<form id="cancel-form" data-challenge-id="${challengeId}"><div class="notice-box warning"><span>!</span><div><strong>취소 이력은 참가자 판단을 위해 기록됩니다</strong><p>Funding 이후에는 일반 취소가 아니라 분쟁·환불 절차를 이용해야 합니다.</p></div></div><div class="field" style="margin-top:18px"><label>취소 사유 <small>5자 이상</small></label><textarea name="reason" required minlength="5" maxlength="500" rows="5" data-count></textarea></div><button class="btn btn-danger btn-block" type="submit">미션 취소</button></form>`, { title: '미션 취소' });
  restoreTransientModalDraft(document.querySelector('#cancel-form'));
}

function openChallengeEditForm(challengeId) {
  const challenge = state.selectedChallenge?.challenge;
  const context = state.selectedChallenge?.context;
  if (!challenge || challenge.id !== challengeId || !context?.canEdit) return toast('현재 수정할 수 없습니다', context?.editBlockedReason || '미션 상태를 다시 확인해주세요.', 'warning');
  const categoryOptions = Object.entries(CATEGORY_META).filter(([key]) => key !== 'ALL').map(([key, meta]) => `<option value="${key}" ${key === challenge.category ? 'selected' : ''}>${meta.label}</option>`).join('');
  openModal(`<form id="challenge-edit-form" data-challenge-id="${challengeId}"><div class="notice-box"><span>✎</span><div><strong>아직 참여가 시작되지 않아 수정할 수 있습니다</strong><p>수정 후 위험·고액 항목은 다시 관리자 검토 대기가 될 수 있습니다.</p></div></div><div class="form-grid" style="margin-top:18px"><div class="field full"><label>제목</label><input name="title" required minlength="5" maxlength="90" value="${escapeAttribute(challenge.title)}" /></div><div class="field full"><label>한 줄 요약</label><input name="summary" required minlength="10" maxlength="180" value="${escapeAttribute(challenge.summary)}" /></div><div class="field full"><label>상세 설명</label><textarea name="description" required minlength="20" maxlength="4000" rows="7">${escapeHTML(challenge.description)}</textarea></div><div class="field"><label>카테고리</label><select name="category" required>${categoryOptions}</select></div><div class="field"><label>지역</label><input name="region" maxlength="80" value="${escapeAttribute(challenge.region || '')}" /></div><div class="field"><label>보상금</label><input name="rewardAmount" type="number" min="${rewardBoundsForUser().min}" max="${rewardBoundsForUser().max}" step="1" required value="${challenge.rewardAmount}" /><small>최소 ${formatWon(rewardBoundsForUser().min)} · 최대 ${formatWon(rewardBoundsForUser().max)}</small></div><div class="field"><label>마감일</label><input name="deadline" type="date" required value="${escapeAttribute(String(challenge.deadline || '').slice(0, 10))}" /></div><div class="field full"><label>성공조건</label><textarea name="successCriteria" required minlength="10" maxlength="1600" rows="4">${escapeHTML(challenge.successCriteria)}</textarea></div><div class="field full"><label>보상금 준비 시점</label><textarea name="paymentTrigger" required minlength="10" maxlength="800" rows="3">${escapeHTML(challenge.paymentTrigger)}</textarea></div><div class="field full"><label>필수 증빙</label><textarea name="evidenceRequirements" required minlength="5" maxlength="800" rows="3">${escapeHTML(challenge.evidenceRequirements)}</textarea></div><div class="field full"><label>공개범위</label><select name="visibility"><option value="public" ${challenge.visibility === 'public' ? 'selected' : ''}>전체 공개</option><option value="unlisted" ${challenge.visibility === 'unlisted' ? 'selected' : ''}>링크 공개</option><option value="private" ${challenge.visibility === 'private' ? 'selected' : ''}>비공개</option></select></div></div><button class="btn btn-primary btn-lg btn-block" type="submit">수정 내용 저장</button></form>`, { title: '미션 수정', wide: true });
  const editForm = document.querySelector('#challenge-edit-form');
  editForm?.querySelector('.notice-box p')?.replaceChildren(document.createTextNode('수정 내용을 저장하면 관리자 대기 없이 즉시 자동 재검수됩니다.'));
  editForm?.querySelector('.form-grid')?.insertAdjacentHTML('afterbegin', `<div class="field full"><label>의뢰 활동 주체</label><select name="subjectType"><option value="individual" ${challenge.ownerSubjectType === 'individual' ? 'selected' : ''}>개인</option><option value="business" ${challenge.ownerSubjectType === 'business' ? 'selected' : ''}>개인사업자</option><option value="corporation" ${challenge.ownerSubjectType === 'corporation' ? 'selected' : ''}>법인</option><option value="organization" ${challenge.ownerSubjectType === 'organization' ? 'selected' : ''}>단체</option></select></div>`);
}

async function submitChallengeEdit(form) {
  const challengeId = form.dataset.challengeId;
  const data = Object.fromEntries(new FormData(form));
  data.rewardAmount = Number(data.rewardAmount);
  const result = await apiClient.updateChallenge(challengeId, data);
  await loadChallenges();
  state.activity = null;
  toast('미션을 수정했습니다', result.moderationAction === 'AUTO_APPROVED' ? '자동 재검수 후 공개되었습니다.' : result.moderationAction === 'CHANGES_REQUIRED' ? '추가 수정이 필요한 항목을 확인해주세요.' : '자동 거절 사유를 확인해주세요.', result.moderationAction === 'AUTO_APPROVED' ? 'success' : 'warning');
  await openChallenge(challengeId);
}

async function submitCancel(form) {
  const challengeId = form.dataset.challengeId;
  const reason = String(new FormData(form).get('reason') || '').trim();
  if (reason.length < 5) throw new ApiError('취소 사유를 5자 이상 입력해주세요.', { code: 'CANCELLATION_REASON_REQUIRED' });
  await apiClient.cancelChallenge(challengeId, reason);
  sessionStorage.removeItem(transientModalDraftKey(form));
  state.activity = null;
  state.selectedChallenge = null;
  closeModal();
  navigate('dashboard');
  toast('미션이 취소되었습니다', '취소 사유와 상태변경 기록이 보존됩니다.', 'success');
  // The cancellation is already complete. A failed background refresh must not
  // keep this flow open or send the user back to a stale detail page.
  loadChallenges().catch(() => undefined);
}

function transientModalDraftKey(form) {
  return `modu-transient-${form?.id || 'form'}-${form?.dataset?.challengeId || 'unknown'}`;
}

function saveTransientModalDraft(form) {
  if (!(form instanceof HTMLFormElement) || !['teaser-form', 'cancel-form'].includes(form.id)) return;
  const values = {};
  new FormData(form).forEach((value, key) => { if (typeof value === 'string') values[key] = value; });
  sessionStorage.setItem(transientModalDraftKey(form), JSON.stringify(values));
}

function restoreTransientModalDraft(form) {
  if (!(form instanceof HTMLFormElement)) return;
  try {
    const values = JSON.parse(sessionStorage.getItem(transientModalDraftKey(form)) || '{}');
    Object.entries(values).forEach(([name, value]) => {
      const field = form.elements.namedItem(name);
      if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLSelectElement) field.value = value;
    });
    form.querySelectorAll('[data-count]').forEach(updateFieldCounter);
  } catch {
    sessionStorage.removeItem(transientModalDraftKey(form));
  }
}

function openDisputeForm(challengeId) {
  openModal(`<form id="dispute-form" data-challenge-id="${challengeId}"><div class="field"><label>분쟁 유형</label><select name="reasonCode"><option value="SUCCESS_CRITERIA">성공조건 판단</option><option value="PAYMENT">Funding·지급</option><option value="EVIDENCE">증빙자료</option><option value="NO_RESPONSE">무응답·중도이탈</option><option value="OTHER">기타</option></select></div><div class="field"><label>상세내용</label><textarea name="description" required minlength="20" maxlength="2000" rows="7"></textarea></div><button class="btn btn-danger btn-block" type="submit">분쟁 접수</button></form>`, { title: '분쟁·이의 제기' });
}

async function submitDispute(form) {
  const challengeId = form.dataset.challengeId;
  const data = Object.fromEntries(new FormData(form));
  await apiClient.openDispute(challengeId, data);
  closeModal();
  state.activity = null;
  await loadChallenges();
  toast('분쟁이 접수되었습니다', '관련 상태와 증빙이 보존되고 운영 검토가 시작됩니다.', 'warning');
}

function openPolicy(type) {
  const policy = POLICIES[type] || POLICIES.rules;
  openModal(`<div class="policy-content">${policy.body}</div>`, { title: policy.title, wide: true, footer: '<button class="btn btn-primary" data-action="close-modal">확인</button>' });
}

function openModal(content, { title = '', footer = '', wide = false } = {}) {
  if (!document.body.classList.contains('modal-open')) modalScrollY = window.scrollY;
  if (!modalRoot.innerHTML && !history.state?.moduModal) {
    history.pushState({ ...(history.state || {}), moduModal: true }, '', location.href);
    modalHistoryEntry = true;
  }
  document.body.style.setProperty('--modal-scroll-y', `${modalScrollY}px`);
  document.body.classList.add('modal-open');
  modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal ${wide ? 'modal-wide' : ''}" role="dialog" aria-modal="true"><header class="modal-header"><h2>${title}</h2><button type="button" data-action="close-modal" aria-label="닫기">×</button></header><div class="modal-body">${content}</div>${footer ? `<footer class="modal-footer">${footer}</footer>` : ''}</section></div>`;
  modalRoot.querySelectorAll('[data-count]').forEach(updateFieldCounter);
  const dialog = modalRoot.querySelector('.modal');
  dialog.setAttribute('tabindex', '-1');
  dialog.focus({ preventScroll: true });
  modalRoot.querySelector('.modal-body').scrollTop = 0;
}

function closeModal({ fromHistory = false, preserveHistory = false } = {}) {
  if (!modalRoot.innerHTML) return;
  modalRoot.innerHTML = '';
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('--modal-scroll-y');
  window.scrollTo(0, modalScrollY);
  if (preserveHistory && modalHistoryEntry && history.state?.moduModal) {
    modalHistoryEntry = false;
    history.replaceState({ ...(history.state || {}), moduModal: false }, '', location.href);
  } else if (!fromHistory && modalHistoryEntry && history.state?.moduModal) {
    modalHistoryEntry = false;
    history.replaceState({ ...(history.state || {}), moduModal: false }, '', location.href);
  } else if (fromHistory) modalHistoryEntry = false;
}

function updateFieldCounter(field) {
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !field.matches('[data-count]')) return;
  let counter = field.parentElement.querySelector('.field-counter');
  if (!counter) {
    counter = document.createElement('small');
    counter.className = 'field-counter';
    field.insertAdjacentElement('afterend', counter);
  }
  const min = Number(field.minLength || 0);
  counter.textContent = `${field.value.length}자${min ? ` / 최소 ${min}자` : ''}`;
  counter.classList.toggle('ready', !min || field.value.length >= min);
}
function renderModalLoading() { return '<div class="loading-panel"><span class="loading-spinner"></span><strong>정보를 불러오고 있습니다</strong></div>'; }

function renderModalRequestError(title, error, retryAction, data = {}) {
  const message = error instanceof ApiError ? error.message : '정보를 불러오는 중 문제가 발생했습니다.';
  const attributes = Object.entries(data)
    .map(([key, value]) => `data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}="${escapeAttribute(value)}"`)
    .join(' ');
  openModal(`<div class="request-error"><span class="auth-icon">!</span><h3>${escapeHTML(title)}</h3><p>${escapeHTML(message)}</p><p class="muted">화면이 닫히지 않도록 유지했습니다. 다시 시도하거나 닫기 버튼을 눌러주세요.</p><button class="btn btn-primary btn-block" type="button" data-action="${escapeAttribute(retryAction)}" ${attributes}>다시 시도</button></div>`, { title });
}

function renderOffline(error) {
  renderHeader();
  main.innerHTML = `<section class="page-section"><div class="container"><div class="offline-panel"><div class="offline-icon">!</div><h1>API 연결을 확인하고 있습니다</h1><p>${escapeHTML(error?.message || '현재 배포 API에 연결할 수 없습니다.')}</p><div class="empty-actions"><button class="btn btn-primary" data-action="retry">다시 시도</button><button class="btn btn-outline" data-action="open-demo">기능 프리뷰 보기</button></div></div></div></section>`;
}

function fatal(error) {
  console.error(error);
  state.loading = false;
  renderOffline(error);
}

async function openDeepLinkedChallenge() {
  if (state.route !== 'explore') return;
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const challengeId = params.get('challenge');
  if (!challengeId || state.selectedChallenge?.challenge?.id === challengeId) return;
  await openChallenge(challengeId);
}

async function refreshCurrentRoute() {
  await loadRouteData();
  render();
}

function navigate(route) {
  closeModal({ preserveHistory: true });
  if (state.route === 'explore' && route !== 'explore') state.search = '';
  if (['how', 'trust'].includes(route)) {
    if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
    else scrollToGuideSection(route);
    return;
  }
  if (location.hash === `#/${route}`) {
    state.route = route;
    refreshCurrentRoute().catch(showError);
  } else location.hash = `#/${route}`;
}

function routeFromHash() { return (location.hash.replace(/^#\/?/, '').split('?')[0] || 'home').toLowerCase(); }
function scrollToGuideSection(route, behavior = 'smooth') {
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.querySelector(`#${route}-section`)?.scrollIntoView({ behavior, block: 'start' });
  }));
}
function openDirectAuthRoute() {
  if (!state.user && state.route === 'signup') openAuthModal('signup');
  if (!state.user && state.route === 'login') openAuthModal('login');
}
function requireLogin(callback) { if (!state.user) return openAuthModal('login'); return callback(); }

async function withBusy(button, callback) {
  if (button?.disabled) return;
  if (button) { button.disabled = true; button.dataset.originalText = button.textContent; button.textContent = '처리 중…'; }
  try { return await callback(); }
  finally { if (button?.isConnected) { button.disabled = false; button.textContent = button.dataset.originalText || '확인'; } }
}

function showError(error) {
  console.error(error);
  const message = error instanceof ApiError ? error.message : '요청을 처리하지 못했습니다.';
  toast('처리하지 못했습니다', message, 'error');
}

function toast(title, message, type = '') {
  const element = document.createElement('div');
  element.className = `toast ${type}`;
  element.innerHTML = `<i>${type === 'success' ? '✓' : type === 'error' ? '!' : type === 'warning' ? '!' : 'i'}</i><div><strong>${escapeHTML(title)}</strong><p>${escapeHTML(message)}</p></div>`;
  toastRoot.append(element);
  setTimeout(() => element.remove(), 4500);
}

function renderExploreGridOnly() {
  const grid = document.querySelector('#explore-grid');
  const count = document.querySelector('#explore-result-count');
  if (!grid || !count) return;
  const filtered = getFilteredChallenges();
  count.textContent = `${filtered.length}개 미션`;
  grid.innerHTML = filtered.length ? `<div class="challenge-grid">${filtered.map(renderChallengeCard).join('')}</div>` : renderEmpty('검색 결과가 없습니다', '다른 검색어나 카테고리를 선택해보세요.');
}

function getFilteredChallenges() {
  let result = [...state.challenges];
  if (state.category !== 'ALL') result = result.filter((challenge) => challenge.category === state.category);
  const query = state.search.trim().toLowerCase();
  if (query) result = result.filter((challenge) => [challenge.title, challenge.summary, challenge.description, challenge.region].join(' ').toLowerCase().includes(query));
  return sortChallenges(result, state.sort);
}

function sortChallenges(challenges, sort) {
  if (sort === 'reward') return challenges.sort((a, b) => b.rewardAmount - a.rewardAmount);
  if (sort === 'deadline') return challenges.sort((a, b) => new Date(a.deadline) - new Date(b.deadline));
  if (sort === 'popular') return challenges.sort((a, b) => (b.viewCount + b.teaserCount * 6) - (a.viewCount + a.teaserCount * 6));
  return challenges.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function updateCreatePreview() {
  const form = document.querySelector('#challenge-create-form');
  if (!form) return;
  const reward = Number(form.elements.rewardAmount?.value || 0);
  const category = form.elements.category?.value || 'CONNECT';
  const settlement = calculateSettlement(Math.max(reward, 1), state.config?.feeRate || 0.1);
  const title = document.querySelector('#preview-title');
  if (title) title.textContent = form.elements.title?.value || '새 미션';
  const categoryEl = document.querySelector('#preview-category');
  if (categoryEl) categoryEl.textContent = CATEGORY_META[category]?.label || category;
  const rewardEl = document.querySelector('#preview-reward');
  if (rewardEl) rewardEl.textContent = formatWon(reward);
  const payoutEl = document.querySelector('#preview-payout');
  if (payoutEl) payoutEl.textContent = reward ? formatWon(settlement.solverPayout) : '0원';
}

function hydratePage() {
  const search = document.querySelector('#explore-search');
  if (search) search.value = state.search;
  const sort = document.querySelector('#explore-sort');
  if (sort) sort.value = state.sort;
  updateCriteriaFromChecks();
  restoreCreateDraft();
  updateCreatePreview();
  hydrateImpactCounters();
  hydrateLiveChallengeRotation();
}

function saveCreateDraft() {
  const form = document.querySelector('#challenge-create-form');
  if (!form) return;
  state.createDraft = {};
  [...form.elements].forEach((field) => {
    if (!field.name || ['successCheck', 'paymentCheck', 'evidenceCheck'].includes(field.name)) return;
    if (field.type === 'checkbox') state.createDraft[field.name] = field.checked;
    else state.createDraft[field.name] = field.value;
  });
}

function restoreCreateDraft() {
  const form = document.querySelector('#challenge-create-form');
  if (!form || !state.createDraft) return;
  Object.entries(state.createDraft).forEach(([name, value]) => {
    const field = form.elements[name];
    if (!field || field instanceof RadioNodeList) return;
    if (field.type === 'checkbox') field.checked = Boolean(value);
    else field.value = value;
  });
}

function hydrateLiveChallengeRotation() {
  if (state.route !== 'home') return;
  const ranked = sortChallenges(state.challenges.filter((challenge) => !['FAILED', 'CANCELLED'].includes(challenge.status)), 'reward');
  if (ranked.length < 2) return;
  const currentId = document.querySelector('[data-live-challenge]')?.dataset.challengeId;
  const currentIndex = ranked.findIndex((challenge) => String(challenge.id) === String(currentId));
  let index = (Math.max(currentIndex, 0) + 1) % ranked.length;
  heroRotationTimer = setInterval(() => {
    const board = document.querySelector('.hero-board');
    const current = board?.querySelector('[data-live-challenge]');
    if (!board || !current) return;
    current.outerHTML = renderHeroChallenge(ranked[index], true);
    index = (index + 1) % ranked.length;
  }, 5000);
}

function hydrateImpactCounters() {
  const counters = [...document.querySelectorAll('[data-impact-counter]')];
  if (!counters.length) return;
  const reducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const animate = (element) => {
    if (element.dataset.animated) return;
    element.dataset.animated = 'true';
    const target = Number(element.dataset.value || 0);
    const format = element.dataset.format || 'number';
    if (reducedMotion || !target) {
      element.textContent = formatImpactCounter(target, format);
      return;
    }
    const startedAt = performance.now();
    const duration = 1100;
    const tick = (now) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      element.textContent = formatImpactCounter(Math.round(target * eased), format);
      if (progress < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  };
  if (!('IntersectionObserver' in window)) return counters.forEach(animate);
  const observer = new IntersectionObserver((entries) => {
    entries.filter((entry) => entry.isIntersecting).forEach((entry) => {
      animate(entry.target);
      observer.unobserve(entry.target);
    });
  }, { threshold: 0.35 });
  counters.forEach((counter) => observer.observe(counter));
}

function renderStep(number, title, description) { return `<article class="step-card"><span>${number}</span><h3>${title}</h3><p>${description}</p></article>`; }
function renderTrustFeature(icon, title, description) { return `<article class="trust-feature"><i>${icon}</i><div><h3>${title}</h3><p>${description}</p></div></article>`; }
function adminMetric(label, value, sub) { return `<article class="admin-metric"><span>${label}</span><strong>${value ?? 0}</strong><small>${sub}</small></article>`; }
function renderEmpty(title, description, action = '') { return `<div class="empty-state"><div class="empty-icon">⌁</div><h3>${escapeHTML(title)}</h3><p>${escapeHTML(description)}</p>${action}</div>`; }
function renderProgressNotice(challenge, context = {}) {
  let title = '티저 접수 중';
  let message = context.isOwner ? '접수된 티저를 검토하고 수행자 후보 1명을 선택하세요.' : '제안한 내용은 내 티저 보기에서 확인할 수 있습니다. 후보선정은 의뢰자가 진행합니다.';
  let action = context.isOwner && !challenge.moderationPending && ['OPEN','REVIEW','SHORTLISTED'].includes(challenge.status) ? 'review-candidates' : '';
  let label = '티저 검토 · 후보선정';
  const blocked = !isMoneyFlowAvailable();
  if (challenge.status === 'DRAFT') { title = '비공개 초안'; message = '아직 공개되지 않은 미션입니다. 공개 후 티저 접수를 시작할 수 있습니다.'; }
  else if (challenge.moderationPending) { title = '공개 검토 대기'; message = '관리자가 등록 내용을 검토한 뒤 티저 접수가 시작됩니다.'; }
  else if (challenge.status === 'SHORTLISTED') {
    title = context.viewerTeaser?.status === 'SHORTLISTED' ? '수행자 후보로 선택되었습니다' : '수행자 후보 선택 · 최종 확정 대기';
    message = '수행자 후보는 현재 1명만 유지됩니다. 후보선정만으로 수행이나 보상 지급이 시작되지는 않으며, 최종 확정과 보상금 확보가 필요합니다.';
    label = '후보 확인 · 최종 확정';
    if (blocked) message += ' 실제 결제·지급 연동은 준비 중입니다. 의뢰자는 아래 ‘가상 거래로 복제해 테스트’에서 이후 단계를 시험할 수 있습니다.';
  } else if (challenge.status === 'FUNDING_REQUIRED') {
    title = '의뢰자의 보상금 확보 대기';
    message = blocked ? '결제·지급 연동 준비 중입니다. 보상금 확보가 확인되면 선정된 수행자가 시작할 수 있습니다.' : '의뢰자가 보상금을 결제하고 결제 확인이 완료되면 수행 단계로 자동 이동합니다.';
    action = context.isOwner && !blocked ? 'fund-challenge' : ''; label = '보상금 확보 진행';
  } else if (['FUNDED', 'EXECUTING'].includes(challenge.status)) {
    title = '선정된 수행자의 미션 수행'; message = '선정된 수행자가 성공조건에 맞춰 일을 수행하고 결과와 증빙을 제출합니다.';
    action = context.isSelectedSolver && challenge.status === 'EXECUTING' ? 'submit-proof' : ''; label = '수행 결과·증빙 제출';
  } else if (challenge.status === 'PROOF_SUBMITTED') {
    title = '의뢰자의 결과 검수 대기'; message = '의뢰자가 제출된 결과와 증빙을 확인하고 완료를 확정합니다. 이후 보상 지급이 진행됩니다.';
    if (blocked) message += ' 현재 결제·지급 연동 준비 중으로 완료 확정은 대기 중입니다.';
    action = context.isOwner && !blocked ? 'confirm-success' : ''; label = '결과 검수 · 완료 확정';
  } else if (challenge.status === 'SUCCESS') {
    const paid = challenge.fundingStatus === 'PAID' || context.settlement?.status === 'PAID';
    title = paid ? '클리어 완료 · 보상 지급 완료' : '클리어 완료 · 보상 지급 대기';
    message = paid ? '지급이 완료되었습니다. 정산내역에서 금액을 확인하세요.' : '의뢰자의 완료 확정이 끝났습니다. 지급 완료 여부는 정산내역에서 확인하세요.';
    action = context.isOwner || context.isSelectedSolver ? 'view-settlement' : ''; label = '정산내역 보기';
  } else if (['CANCELLED', 'FAILED', 'DISPUTED'].includes(challenge.status)) {
    title = { CANCELLED:'취소된 미션', FAILED:'종료된 미션', DISPUTED:'분쟁 검토 중' }[challenge.status];
    message = '현재 일반 진행이 중단된 상태입니다. 기존 제출 내용과 진행 기록은 보존됩니다.'; action = '';
  }
  return `<section class="workflow-notice" aria-label="현재 진행상황"><strong>${title}</strong><p>${message}</p>${action ? `<button type="button" class="btn btn-primary" data-action="${action}" data-challenge-id="${escapeAttribute(challenge.id)}">${label}</button>` : ''}</section>`;
}

function renderFlow(challenge, context = {}) {
  const steps = [['미션 공개','의뢰자 · 미션과 성공조건 등록'],['티저 도전','도전자 · 제안 제출'],['후보선정','의뢰자 · 후보 비교 후 최종 1명 확정'],['보상금 확보','의뢰자 · 결제 / 서비스 · 입금 확인'],['미션 수행','최종 수행자 · 수행 후 결과 제출'],['결과 검수','의뢰자 · 증빙 확인 후 완료 확정'],['보상 지급','지급 처리 후 정산내역 확인']];
  const current = flowIndex(challenge);
  const stopped = ['CANCELLED','FAILED','DISPUTED'].includes(challenge.status);
  const paid = challenge.fundingStatus === 'PAID' || context.settlement?.status === 'PAID';
  return `<ol class="flow-steps" aria-label="미션 진행 단계">${steps.map(([name, desc], index) => {
    const done = !stopped && (index < current || (index === 6 && paid));
    const active = !stopped && index === current && !done;
    return `<li class="flow-step ${done ? 'done' : active ? 'active' : ''}" ${active ? 'aria-current="step"' : ''}><i aria-hidden="true">${done ? '✓' : index + 1}</i><div><strong>${name}${active ? ' · 현재' : ''}</strong><span>${desc}</span></div></li>`;
  }).join('')}</ol>`;
}

function flowIndex(challenge) { return ({ OPEN:0, REVIEW:1, SHORTLISTED:2, FUNDING_REQUIRED:3, FUNDED:4, EXECUTING:4, PROOF_SUBMITTED:5, SUCCESS:6, FAILED:6, CANCELLED:6, DISPUTED:5 })[challenge.status] ?? 0; }
function shareChallenge(challengeId) { const challenge = state.challenges.find((item) => item.id === challengeId) || state.selectedChallenge?.challenge; const url = `${location.origin}${location.pathname}#/explore?challenge=${encodeURIComponent(challengeId)}`; const text = `모두의클리어 · ${challenge?.title || '모두의클리어'} · 보상금 ${formatWon(challenge?.rewardAmount)}`; if (navigator.share) return navigator.share({ title: '모두의클리어', text, url }).catch(() => undefined); if (navigator.clipboard) return navigator.clipboard.writeText(`${text}\n${url}`).then(() => toast('공유 링크를 복사했습니다', '카카오톡·문자·SNS에 붙여넣으세요.', 'success')); openModal(`<p>${escapeHTML(url)}</p>`, { title: '공유 링크' }); }
function initial(name) { return String(name || '?').replace(/\s/g, '').slice(0, 1); }
function formatWon(value) { return `${Math.round(Number(value || 0)).toLocaleString('ko-KR')}원`; }
function formatCompactWon(value) { const n = Number(value || 0); if (n >= 100000000) return `${(n / 100000000).toFixed(n % 100000000 ? 1 : 0)}억원`; if (n >= 10000) return `${Math.round(n / 10000).toLocaleString('ko-KR')}만원`; return formatWon(n); }
function formatImpactCounter(value, format) { const n = Math.round(Number(value || 0)); if (format === 'won') return formatCompactWon(n); if (format === 'hours') return `${n.toLocaleString('ko-KR')}시간`; return n.toLocaleString('ko-KR'); }
function formatDate(value) { if (!value) return '-'; return new Intl.DateTimeFormat('ko-KR', { year:'numeric', month:'2-digit', day:'2-digit' }).format(new Date(value)); }
function formatDateTime(value) { if (!value) return '-'; return new Intl.DateTimeFormat('ko-KR', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(value)); }
function daysLeft(value) { return Math.max(0, Math.ceil((new Date(value).getTime() - Date.now()) / 86400000)); }
function relativeDate(value) { const diff = Date.now() - new Date(value).getTime(); if (diff < 3600000) return `${Math.max(1, Math.floor(diff / 60000))}분 전`; if (diff < 86400000) return `${Math.floor(diff / 3600000)}시간 전`; return `${Math.floor(diff / 86400000)}일 전`; }
function stars(rating) { return '★'.repeat(Math.max(0, rating)) + '☆'.repeat(Math.max(0, 5 - rating)); }
function teaserStatusLabel(status) { return ({ SUBMITTED:'제출완료', VIEWED:'검토중', SHORTLISTED:'후보선정 완료', SELECTED:'최종 수행자 확정', REJECTED:'미선정', WITHDRAWN:'철회' })[status] || status; }
function trustMeta(value) {
  const score = Math.max(0, Math.min(100, Number(value) || 0));
  if (score >= 90) return { score, tier: 'prime', label: '최고 신뢰' };
  if (score >= 80) return { score, tier: 'trusted', label: '신뢰' };
  if (score >= 65) return { score, tier: 'steady', label: '안정' };
  if (score >= 45) return { score, tier: 'growing', label: '성장 중' };
  return { score, tier: 'caution', label: '주의 필요' };
}

function trustLabel(score) { return trustMeta(score).label; }

function renderTrustGauge(value, options = {}) {
  const { score, tier, label } = trustMeta(value);
  const classes = ['trust-gauge', `trust-${tier}`, options.compact ? 'trust-gauge-compact' : '', options.detailed ? 'trust-gauge-detailed' : '', options.inverse ? 'trust-gauge-inverse' : ''].filter(Boolean).join(' ');
  const tag = options.userId ? 'button' : 'div';
  const interaction = options.userId ? ` type="button" data-action="view-trust-history" data-user-id="${escapeAttribute(options.userId)}" title="신뢰내역 보기"` : '';
  return `<${tag} class="${classes} ${options.userId ? 'trust-gauge-clickable' : ''}" aria-label="모두의클리어 신뢰도 ${score}점, ${label}"${interaction}><div class="trust-gauge-head"><span>클리어 신뢰도</span><strong>${score}<small>/100</small></strong><em>${label}</em></div><div class="trust-gauge-track" role="meter" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}"><i style="width:${score}%"></i></div>${options.detailed ? '<div class="trust-gauge-scale"><span>주의</span><span>성장</span><span>안정</span><span>신뢰</span></div>' : ''}</${tag}>`;
}
function accountTypeLabel(type) { return ({ individual:'개인', business:'개인사업자', corporation:'법인', organization:'단체' })[type] || type; }
function verifyBadge(label, active) { return `<span class="verify-badge ${active ? '' : 'off'}">${active ? '✓' : '○'} ${label}</span>`; }
function verificationSummary(owner) { return [owner?.identityVerified && '본인', owner?.businessVerified && '사업자', owner?.professionalVerified && '전문자격'].filter(Boolean).join('·') + ([owner?.identityVerified, owner?.businessVerified, owner?.professionalVerified].some(Boolean) ? ' 확인' : '미확인'); }
function nl2br(value) { return escapeHTML(value).replace(/\n/g, '<br>'); }
function escapeHTML(value) { return String(value ?? '').replace(/[&<>'"]/g, (character) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[character]); }
function escapeAttribute(value) { return escapeHTML(value).replace(/`/g, '&#96;'); }

const POLICIES = {
  terms: { title: '이용약관 · 현재 서비스 범위', body: '<h3>플랫폼의 역할</h3><p>모두의클리어는 미션 게시·참가·TEASER·후보선정·진행기록·Funding 상태·정산·리뷰 기능을 제공합니다.</p><h3>당사자의 책임</h3><p>미션의 적법성, 필요한 자격·면허·권한과 제공정보의 정확성은 관련 당사자가 확인합니다. 플랫폼은 불법·허위·권리침해를 인지한 경우 게시 제한과 자료보존 등 필요한 조치를 수행합니다.</p><h3>운영자·이용 제한</h3><p>운영·관리 주체는 (주)ISEA GROUP입니다. 회원가입과 이메일·소셜 로그인은 본인확인이 아닙니다. 유효한 본인확인 및 활동 자격이 확인되지 않으면 신규 의뢰·도전·후보선정을 제한합니다.</p><h3>현재 거래 상태</h3><p>실제 결제·자금보관·환불·지급 서비스는 제공하지 않습니다. 예시·가상 거래는 실제 계약 이행이나 입금·송금을 증명하지 않습니다. 외부 계좌로 보상금을 임의 송금하지 마세요.</p><h3>거래 개시 조건</h3><p>인증·결제·지급업체 계약, 사업자 표시사항, 고객지원 연락처, 전체 거래약관과 개인정보 처리방침을 확정·고지한 뒤 별도 동의를 받아야 실거래를 개시할 수 있습니다. 기존 동의를 변경된 거래약관에 대한 동의로 간주하지 않습니다.</p>' },
  privacy: { title: '개인정보 처리 안내 · 거래 기능 준비 중', body: '<h3>처리 주체</h3><p>개인정보 처리·관리 주체는 ㈜ISEA GROUP입니다.</p><h3>수집 항목과 목적</h3><p>회원가입 시 이름·활동명, 휴대전화, 이메일, 비밀번호 검증값, 활동 지역, 출생연도, 성별, 참여 목적을 수집하여 계정 생성·연락·서비스 운영에 사용하며 입력만으로 본인확인을 완료하지 않습니다. 관심·전문분야, 기관·회사명, 마케팅 수신 동의는 선택 항목입니다.</p><h3>본인확인 정보</h3><p>기관 연동 시 명시적 동의를 받고 인증 결과를 서버에서 조회합니다. 중복확인 식별값은 비밀키 기반 해시로 처리하며 원본 주민등록번호·신분증·CI·DI는 저장하지 않는 구조입니다. 연계정보 해시도 개인정보로 보호합니다. 인증 유효기간은 운영정책상 1년이며 철회·만료 시 재확인합니다.</p><h3>사업자·법인·단체 자격 심사</h3><p>개인 본인확인과 별도로 등록 증빙·대표 또는 위임 권한을 심사합니다. 계약과 처리방침이 확정되기 전에는 접수를 차단합니다. 신청 정보와 가린 이미지 증빙은 암호화하여 신청자와 최고관리자만 열람하며, 접수일부터 30일 후 원문을 파기합니다. 승인 자격은 1년 후 재확인하며 최소 심사·열람 기록은 1년 보유 후 파기합니다. 주민등록번호·신분증·계좌번호는 제출하지 마세요. 원문이 포함된 암호화 배포 백업은 최대 90일 후 삭제하며 복원 시 파기 기한을 다시 적용합니다.</p><h3>거래 개시 전 확정 항목</h3><p>수탁사·보유기간·파기·권리행사 절차는 실제 운영사와 제공사를 확정한 후 전체 방침에 반영합니다.</p>' },
  rules: { title: '운영정책 · TRUST · 3-Strike', body: '<h3>일반 미이행</h3><p>정당한 사유 없는 Funding 미이행·반복 잠수·허위 TEASER는 경고, 한도축소, 기능제한, 장기정지 단계로 처리할 수 있습니다.</p><h3>즉시 제한</h3><p>허위신원·자격위조·증거조작·불법거래·개인정보 악용 등 중대한 행위는 즉시 제한할 수 있습니다.</p><h3>이의신청</h3><p>파산·중대한 사고 등 객관적인 사유가 있으면 예외심사를 신청할 수 있습니다.</p>' },
  fees: { title: '수수료·Funding·정산 정책', body: '<h3>기본 수수료</h3><p>클리어 성공 시 표시 보상금의 10%를 플랫폼 이용수수료로 정산하고 나머지 90%를 성공자에게 지급하는 구조가 기본입니다.</p><h3>취소·환불·분쟁</h3><p>현재 실제 청구는 차단되어 있습니다. 거래 개시 후 결제 전 취소는 청구 없이 종료하고, 결제 후에는 업체의 원거래 취소 결과가 확인되어야 환불 완료로 표시합니다. 수행·검수 중 이견은 분쟁으로 접수하여 지급을 보류하고, 합의 또는 심사 결과를 기록합니다. 지급 요청과 지급 완료를 구분하며 실패·응답 지연 때 재송금하지 않습니다. 이미 송금된 금액은 자동 환불로 처리하지 않습니다.</p><h3>정산 내역</h3><p>10만원 보상 기준 서비스 수수료 1만원, 수행자 예상액 9만원입니다. 적용 세금·원천징수·PG 비용·취소기한·정산일은 계약과 검토 후 개시 전에 확정 고지합니다.</p><h3>고지</h3><p>목록에서는 보상금을 중심으로 표시하되, 참가 확정 전 수수료율과 예상 실수령액을 확인할 수 있도록 고지합니다.</p><h3>후행 Funding</h3><p>등록 시 선결제하지 않고 FINALIST 선정 등 사전에 정한 시점에서 승인된 결제·지급 구조로 자금을 확보합니다.</p>' },
};

function fundingDisplay(challenge) {
  if (challenge.isExample || String(challenge.id || '').startsWith('demo_') || String(challenge.title || '').startsWith('[예시]')) return {label:'예시 · 실제 결제·지급 없음',funded:false};
  const meta = FUNDING_META[challenge.fundingStatus] || {label:challenge.fundingStatus,funded:false};
  if (!state.config?.moneyEnabled && meta.funded) return {label:'실거래 내역 확인 필요',funded:false};
  return meta;
}
function renderLaunchReadiness(overview) {
  return `<section class="page-section"><div class="container"><section class="dashboard-card"><span class="admin-kicker">거래 개시 점검</span><h2>실제 결제·지급 차단 중</h2><p>본인확인, 사업자·법인·단체 권한 심사, PG 자금보관 계약, 지급업체 KYC 및 실거래 검증이 필요합니다. 환경설정만으로 실거래를 켤 수 없습니다.</p><div class="preview-list"><div class="preview-row"><span>양측 본인확인</span><strong>필수 · 미인증 활동 차단</strong></div><div class="preview-row"><span>PG·지급 연동</span><strong>미완료</strong></div><div class="preview-row"><span>가상 거래</span><strong>실제 청구·송금 0원</strong></div></div><button class="btn btn-outline" data-action="admin-verifications">인증 요청 심사·재확인</button> <button class="btn btn-outline" data-action="admin-entity-cases">사업자·법인·단체 심사</button></section></div></section>`;
}
async function openAdminVerifications() {
  openModal(renderModalLoading(),{title:'인증 요청 심사',wide:true});
  try {
    const data=await apiClient.verificationReviews();
    openModal(`<p>기관 검증 없이 인증 완료로 승인할 수 없습니다. 거절·철회·재확인 요청에는 사유와 관리자 감사기록이 남습니다.</p><div class="audit-table">${data.verifications.length ? data.verifications.map(v=>`<div class="audit-row"><strong>${escapeHTML(VERIFICATION_LABELS[v.verification_type])} · ${escapeHTML(v.status)}</strong><span>${escapeHTML(v.user_id)}<br>${escapeHTML(v.status_reason||'')}</span><button class="btn btn-outline btn-small" data-action="review-verification" data-verification-id="${escapeAttribute(v.id)}">심사</button></div>`).join(''):'<p>접수된 인증 요청이 없습니다.</p>'}</div>`,{title:'인증 요청 심사',wide:true});
  } catch(error) { renderModalRequestError(error); }
}
function openVerificationReview(id) {
  openModal(`<form id="verification-review-form" class="auth-form"><input type="hidden" name="verificationId" value="${escapeAttribute(id)}"><label>심사 결과<select name="decision"><option value="RECONFIRM_REQUIRED">재확인 필요</option><option value="REJECTED">거절</option><option value="REVOKED">인증 철회</option></select></label><label>사유<textarea name="reason" minlength="10" maxlength="500" required></textarea></label><p>민감정보나 신분증 내용을 사유에 입력하지 마세요.</p><button class="btn btn-primary" type="submit">심사 기록 저장</button></form>`,{title:'인증 심사'});
}
async function submitVerificationReview(form) {
  await apiClient.reviewVerification(Object.fromEntries(new FormData(form)));
  await openAdminVerifications();
}

let identitySdkPromise;
async function startIdentityVerification(form) {
  if(!new FormData(form).has('consent')) throw new Error('본인확인 처리 동의가 필요합니다.');
  const attempt=await apiClient.startIdentity({consent:true,consentVersion:state.verifications.identityConsentVersion});
  if(!identitySdkPromise) identitySdkPromise=new Promise((resolve,reject)=>{
    const script=document.createElement('script');script.src='https://cdn.portone.io/v2/browser-sdk.js';script.async=true;
    script.onload=()=>window.PortOne ? resolve(window.PortOne) : reject(new Error('인증 창을 불러오지 못했습니다.'));
    script.onerror=()=>{identitySdkPromise=null;reject(new Error('인증기관 연결을 확인해주세요.'));};
    document.head.appendChild(script);
  });
  const sdk=await identitySdkPromise;
  const result=await sdk.requestIdentityVerification({...attempt,redirectUrl:location.origin+'/'});
  if(result?.code) throw new Error('인증이 완료되지 않았습니다. 다시 시도해주세요.');
  if(!result?.identityVerificationId) return;
  await apiClient.completeIdentity({identityVerificationId:result.identityVerificationId});
  await openVerificationManager();
}
async function completeIdentityRedirect() {
  const params=new URLSearchParams(location.search),id=params.get('identityVerificationId');
  history.replaceState(null,'',location.pathname+(location.hash || '#/dashboard'));
  try {
    if(params.has('code')) throw new Error('본인확인이 취소되거나 실패했습니다.');
    await apiClient.completeIdentity({identityVerificationId:id});
    state.user=await loadCurrentUser();
    toast('본인확인', '기관 본인확인 결과를 확인했습니다.', 'success');
  } catch(error) { showError(error); }
}
