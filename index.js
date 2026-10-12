import { extension_settings, getContext } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';

const MODULE = 'next_message';
const DEFAULT_PROMPT = `(OOC: There is no new IC input from the user this turn. Continue the narrative naturally from the character's last response. Do not repeat or summarize the previous user input or character response.)`;
const POSITIONS = ['end', 'before_prefill', 'after_char'];
const CLICK_TIMEOUT_MS = 10000;
const DEFAULTS = { enabled: true, prompt: DEFAULT_PROMPT, position: 'before_prefill', presets: [], activePreset: '' };

/* ---------- 설정 ---------- */
function settings() {
    if (!extension_settings[MODULE]) extension_settings[MODULE] = {};
    const s = extension_settings[MODULE];
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!Object.prototype.hasOwnProperty.call(s, k)) s[k] = Array.isArray(v) ? [] : v;
    }
    return s;
}

/* ---------- 프롬프트 프리셋 (저장 / 선택 / 삭제) ---------- */
const isValidPreset = (p) => !!p && typeof p.id === 'string' && typeof p.name === 'string' && typeof p.text === 'string';

function cleanPresets() {
    const s = settings();
    if (!POSITIONS.includes(s.position)) s.position = 'before_prefill';
    s.presets = Array.isArray(s.presets) ? s.presets.filter(isValidPreset) : [];
    if (typeof s.activePreset !== 'string' || !s.presets.some((p) => p.id === s.activePreset)) s.activePreset = '';
}

function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

/** 같은 이름이 있으면 덮어쓰고, 없으면 새로 만든다. 저장한 프리셋을 선택 상태로 둔다. */
function upsertPreset(name, text) {
    const s = settings();
    let p = s.presets.find((x) => x.name === name);
    if (p) {
        p.text = text;
    } else {
        p = { id: newId(), name, text };
        s.presets.push(p);
    }
    s.activePreset = p.id;
    return p;
}

function removePreset(id) {
    const s = settings();
    s.presets = s.presets.filter((p) => p.id !== id);
    if (s.activePreset === id) s.activePreset = '';
}

/** 프리셋을 선택하고 그 내용을 현재 프롬프트로 쓴다. 빈 값이면 선택만 해제한다. */
function applyPreset(id) {
    const s = settings();
    const p = s.presets.find((x) => x.id === id) || null;
    s.activePreset = p ? p.id : '';
    if (p) s.prompt = p.text;
    return p;
}

/* ---------- 실행 기록 (메모리 전용) ----------
 * 요청 하나(전송 버튼 클릭 또는 생성 요청)가 블록 하나가 된다.
 *
 *   #3 15:02:58  전송 버튼 클릭 (빈 입력)
 *     요청: normal · openai · 메시지 9개 · 클릭 유효
 *     마지막: 캐릭터 Ghost
 *     → 주입함: 맨 끝 (6/6번째), 같은 문장 0→1회
 *     확인: 최종 전송본에 포함 (문장 1회, 마지막 등장 6/6번째, 맨 끝 역할 user)
 *     끝 15:03:20 (22초)
 *
 * 오류는 "! 오류"로 시작하고, 문제가 있는 확인 결과는 "! 확인"으로 시작한다.
 */
const MAX_ENTRIES = 80;
const logEntries = [];  // { no, time, head, lines, startMs }  (no가 null이면 한 줄짜리 알림)
let logOpen = false;
let reqSeq = 0;
let activeEntry = null; // 지금 이어 적고 있는 요청 블록
let clickEntry = null;  // 전송 버튼 클릭 때 만든 블록 { entry, time } (이어지는 생성 요청이 이어 적는다)

function timestamp() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function renderText() {
    const out = [];
    let prevReq = false;
    for (const e of logEntries) {
        if (e.no === null) {
            if (prevReq) out.push('');
            out.push(`${e.time}  ${e.head}`);
            prevReq = false;
        } else {
            if (out.length) out.push('');
            out.push(`#${e.no} ${e.time}  ${e.head}`);
            for (const l of e.lines) out.push(`  ${l}`);
            prevReq = true;
        }
    }
    return out.join('\n');
}

function renderLog() {
    const el = document.getElementById('nm_log_text');
    if (!el) return;
    el.value = logEntries.length ? renderText() : '아직 기록이 없습니다.';
    el.scrollTop = el.scrollHeight;
}

function pushEntry(entry) {
    logEntries.push(entry);
    while (logEntries.length > MAX_ENTRIES) logEntries.shift();
    return entry;
}

/** 새 요청 블록을 만들고 이어 적을 블록으로 지정한다. */
function newRequestEntry(head) {
    reqSeq += 1;
    const entry = pushEntry({ no: reqSeq, time: timestamp(), head, lines: [], startMs: Date.now() });
    activeEntry = entry;
    if (logOpen) renderLog();
    return entry;
}

/** 특정 블록에 한 줄 덧붙인다. */
function logTo(entry, msg) {
    entry.lines.push(msg);
    if (logOpen) renderLog();
}

/** 한 줄짜리 알림 (요청과 상관없는 일) */
function logNote(msg) {
    pushEntry({ no: null, time: timestamp(), head: msg, lines: [], startMs: Date.now() });
    if (logOpen) renderLog();
}

/** 진행 중인 요청 블록에 한 줄 덧붙인다. 진행 중인 블록이 없으면 한 줄 알림으로 남긴다. */
function log(msg) {
    if (activeEntry) logTo(activeEntry, msg);
    else logNote(msg);
}

/** 진행 중인 요청 블록을 마무리한다. */
function endActive(label) {
    if (activeEntry) {
        const sec = Math.round((Date.now() - activeEntry.startMs) / 1000);
        logTo(activeEntry, `${label} ${timestamp()} (${sec}초)`);
        activeEntry = null;
    }
}

async function copyLog() {
    if (!logEntries.length) {
        toastr.info('아직 기록이 없습니다.');
        return;
    }
    const text = renderText();
    try {
        await navigator.clipboard.writeText(text);
        toastr.success('실행 기록을 복사했습니다.');
        return;
    } catch (e) { /* 선택 복사로 대체 */ }
    try {
        const el = document.getElementById('nm_log_text');
        el.focus();
        el.select();
        el.setSelectionRange(0, el.value.length);
        if (document.execCommand('copy')) {
            toastr.success('실행 기록을 복사했습니다.');
            return;
        }
    } catch (e) { /* 아래 안내 */ }
    toastr.warning('자동 복사에 실패했습니다. 기록 칸을 길게 눌러 직접 복사하세요.');
}

/* ---------- 오류 기록: 한글 설명 + 브라우저 원문 + 위치(스택 앞부분) ---------- */
function stackHead(err, count = 3) {
    const raw = err && err.stack ? String(err.stack).split('\n') : [];
    const msg = err && err.message ? String(err.message) : '';
    const lines = raw.map((s) => s.trim()).filter(Boolean);
    // Chrome 계열은 첫 줄이 "Error: 메시지"라서 건너뛴다. (Safari/Firefox는 첫 줄부터 위치)
    if (lines.length && msg && lines[0].includes(msg)) lines.shift();
    return lines.slice(0, count).map((s) => s.split(location.origin).join('')).join(' | ');
}

function reportError(err, what = '알 수 없는 단계') {
    console.error('[Next Message]', err);
    const name = err && err.name ? err.name : 'Error';
    const msg = err && err.message ? err.message : String(err);
    log(`! 오류: ${what} 중 문제 발생 → ${name}: ${msg}`);
    const where = stackHead(err);
    if (where) log(`  위치: ${where}`);
}

/* ---------- 요청 상태 (요청 단위 임시 데이터) ---------- */
let pendingClick = null; // { time, timer }
let request = null;      // { type, skip, injected, verified, text, before }
const groupRound = { active: false, valid: false };

function clearPending() {
    if (pendingClick) {
        clearTimeout(pendingClick.timer);
        pendingClick = null;
    }
}

function skip(reason) {
    if (request) request.skip = true;
    log(`→ 주입 안 함: ${reason}`);
}

/** 채팅 메시지를 기록용 한 줄로 설명한다. */
function describeMsg(m) {
    if (!m) return '없음';
    const who = m.is_system ? '시스템' : m.is_user ? '유저' : '캐릭터';
    return m.name ? `${who} ${m.name}` : who;
}

/* ---------- 메시지 속 문장 세기 ---------- */
function contentTexts(m) {
    if (!m) return [];
    if (typeof m.content === 'string') return [m.content];
    if (Array.isArray(m.content)) {
        return m.content.filter((p) => p && typeof p.text === 'string').map((p) => p.text);
    }
    return [];
}
function countIn(m, text) {
    let n = 0;
    for (const t of contentTexts(m)) n += t.split(text).length - 1;
    return n;
}
function countAll(messages, text) {
    return messages.reduce((n, m) => n + countIn(m, text), 0);
}
function lastIndexWith(messages, text) {
    for (let i = messages.length - 1; i >= 0; i--) {
        if (countIn(messages[i], text) > 0) return i;
    }
    return -1;
}

/** 공백을 하나로 줄여서 비교한다. (프롬프트로 바뀌면서 줄바꿈/공백이 달라져도 찾기 위해) */
function norm(s) {
    return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 채팅 메시지의 끝부분(30자)을 찾을 표식으로 쓴다. */
function snippetOf(mes) {
    return norm(mes).slice(-30);
}

/** 프롬프트 메시지 목록에서 표식이 들어 있는 가장 뒤쪽 메시지의 위치를 찾는다. 없으면 -1. */
function findMessageIndex(messages, snip) {
    if (!snip) return -1;
    for (let i = messages.length - 1; i >= 0; i--) {
        if (contentTexts(messages[i]).some((t) => norm(t).includes(snip))) return i;
    }
    return -1;
}

/**
 * 주입 위치를 정한다.
 *  - end            : 프롬프트 맨 끝
 *  - before_prefill : 캐릭터 마지막 메시지 뒤에 이어지는 "맨 끝 assistant 메시지"를 프리필로 보고 그 앞
 *  - after_char     : 캐릭터 마지막 메시지 바로 뒤
 * 캐릭터 마지막 메시지를 프롬프트에서 못 찾으면(anchorIdx < 0) 맨 끝으로 대신한다.
 */
function choosePosition(mode, chat, anchorIdx) {
    const end = chat.length;
    const notFound = '맨 끝 (캐릭터 마지막 메시지를 프롬프트에서 찾지 못함)';
    if (mode === 'after_char') {
        if (anchorIdx < 0) return { at: end, how: notFound };
        return { at: anchorIdx + 1, how: '캐릭터 마지막 메시지 바로 뒤' };
    }
    if (mode === 'before_prefill') {
        if (anchorIdx < 0) return { at: end, how: notFound };
        let at = end;
        while (at - 1 > anchorIdx && chat[at - 1] && chat[at - 1].role === 'assistant') at--;
        if (at === end) return { at: end, how: '맨 끝 (프리필 없음)' };
        return { at, how: `프리필 ${end - at}개 앞` };
    }
    return { at: end, how: '맨 끝' };
}

/* ---------- 전송 버튼 클릭 감지 (입력창이 비워지기 전에 캡처) ---------- */
function onDocumentClick(e) {
    const btn = e.target instanceof Element ? e.target.closest('#send_but') : null;
    if (!btn) return;
    try {
        const textarea = document.getElementById('send_textarea');
        const text = String(textarea ? textarea.value : '').trim();
        const empty = text === '';
        clearPending();
        const entry = newRequestEntry(empty ? '전송 버튼 클릭 (빈 입력)' : '전송 버튼 클릭 (입력 있음)');
        clickEntry = { entry, time: Date.now() };
        if (empty) {
            const timer = setTimeout(() => {
                if (pendingClick && pendingClick.timer === timer) {
                    pendingClick = null;
                    logTo(entry, `! 대기 시간 초과: 클릭 후 ${CLICK_TIMEOUT_MS / 1000}초 안에 생성 요청이 오지 않음`);
                    if (clickEntry && clickEntry.entry === entry) clickEntry = null;
                    if (activeEntry === entry) activeEntry = null;
                }
            }, CLICK_TIMEOUT_MS);
            pendingClick = { time: Date.now(), timer };
        } else {
            activeEntry = null; // 내용이 있는 전송은 주입 대상이 아님. 이어지는 생성 요청이 이 블록에 이어 적는다.
        }
    } catch (err) {
        reportError(err, '전송 버튼 클릭 감지');
    }
}

/* ---------- 생성 요청 도착 ---------- */
function onGenerationStarted(type, params, dryRun) {
    try {
        if (dryRun === true) return;
        const t = type || 'normal';
        const ctx = getContext();
        const chat = ctx.chat || [];
        const last = chat[chat.length - 1];
        const api = ctx.mainApi;

        const clickValid = !!(pendingClick && Date.now() - pendingClick.time <= CLICK_TIMEOUT_MS);
        const valid = clickValid || (groupRound.active && groupRound.valid);
        const isGroup = !!ctx.groupId || groupRound.active;

        // 요청 블록: 전송 버튼 클릭으로 시작된 일반 요청은 클릭 때 만든 블록에 이어 적고, 아니면 새 블록을 만든다.
        if (t === 'normal' && clickEntry && Date.now() - clickEntry.time <= CLICK_TIMEOUT_MS) {
            activeEntry = clickEntry.entry;
            clickEntry = null;
        } else {
            newRequestEntry(`생성 요청 (${t})`);
        }
        const entry = activeEntry;

        // 클릭 기록은 일반 전송 요청만 소모한다. (그 사이 끼어드는 quiet 요청 등이 가로채지 못하게)
        if (pendingClick && t === 'normal') {
            if (groupRound.active) groupRound.valid = clickValid;
            clearPending();
        } else if (pendingClick) {
            log('클릭 기록은 그대로 둠 (다른 유형 요청)');
        }

        const tail = chat.slice(-2).map((m) => ({
            is_user: !!(m && m.is_user),
            is_system: !!(m && m.is_system),
            snip: snippetOf(m && m.mes),
        }));
        request = { no: entry.no, entry, type: t, tail, skip: false, injected: false, verified: false, text: null, before: 0, at: 0 };

        log(`요청: ${t} · ${api ?? 'API 미확인'} · 메시지 ${chat.length}개${isGroup ? ' · 그룹' : ''} · 클릭 ${valid ? '유효' : '없음'}`);
        log(`마지막: ${describeMsg(last)}`);

        const s = settings();
        let reason = null;
        if (!s.enabled) reason = '비활성화';
        else if (!String(s.prompt || '').trim()) reason = '프롬프트 비어 있음';
        else if (api && api !== 'openai') reason = 'Chat Completion API가 아님';
        else if (!['normal', 'regenerate', 'swipe'].includes(t)) reason = '일반 전송이 아닌 생성';
        else if (t === 'normal') {
            if (!valid) reason = '빈 입력 전송이 아님';
            else if (!last) reason = '마지막 메시지가 없음';
            else if (last.is_system) reason = '마지막 메시지가 시스템 메시지';
            else if (last.is_user) reason = '마지막 메시지가 유저 것';
        }
        if (reason) skip(reason);
    } catch (err) {
        reportError(err, '생성 요청 확인');
    }
}

/* ---------- 프롬프트 완성 직후: 임시 주입 ---------- */
function onPromptReady(data) {
    try {
        if (!data || data.dryRun) return;
        if (!request || request.skip) return;
        if (request.injected) {
            log('→ 주입 안 함: 이미 주입됨');
            return;
        }
        if (!Array.isArray(data.chat)) {
            skip('채팅 방식 프롬프트가 아님');
            return;
        }
        const text = String(settings().prompt || '').trim();
        if (!text) {
            skip('프롬프트 비어 있음');
            return;
        }

        // 캐릭터 마지막 메시지가 프롬프트의 어디 있는지 찾는다. (주입 위치 계산과 재생성/스와이프 판단에 쓴다)
        let anchorIdx = -1;
        if (request.type === 'normal') {
            const c = request.tail[request.tail.length - 1];
            anchorIdx = c ? findMessageIndex(data.chat, c.snip) : -1;
        } else {
            // 재생성/스와이프: 바꿔 쓸 메시지는 프롬프트에서 빠지므로, 최근 두 메시지 중 프롬프트에 실제로 있는 것을 마지막 메시지로 본다.
            let found = null;
            for (let k = request.tail.length - 1; k >= 0 && !found; k--) {
                const i = findMessageIndex(data.chat, request.tail[k].snip);
                if (i >= 0) found = { c: request.tail[k], i };
            }
            if (!found) { skip('마지막 메시지를 프롬프트에서 찾지 못함'); return; }
            if (found.c.is_system) { skip('마지막 메시지가 시스템 메시지'); return; }
            if (found.c.is_user) { skip('마지막 메시지가 유저 것'); return; }
            anchorIdx = found.i;
        }
        const { at, how } = choosePosition(settings().position, data.chat, anchorIdx);

        // 안전장치: 넣을 자리 바로 앞뒤에 이미 같은 문장의 유저 메시지가 있으면 건너뜀
        const near = [data.chat[at - 1], data.chat[at]];
        if (near.some((m) => m && m.role === 'user' && typeof m.content === 'string' && m.content.trim() === text)) {
            skip('안전장치로 건너뜀');
            return;
        }

        // 이번 요청의 임시 배열에만 추가 (채팅/메시지 객체는 건드리지 않음)
        const before = countAll(data.chat, text);
        data.chat.splice(at, 0, { role: 'user', content: text });
        request.injected = true;
        request.at = at;
        request.text = text;
        request.before = before;
        log(`→ 주입함: ${how} (${at + 1}/${data.chat.length}번째), 같은 문장 ${before}→${countAll(data.chat, text)}회`);
    } catch (err) {
        reportError(err, '프롬프트 주입');
    }
}

/* ---------- 실제 전송 직전: 최종 확인 ---------- */
function onSettingsReady(generateData) {
    try {
        if (!request || !request.injected || request.verified) return;
        request.verified = true;
        const msgs = generateData && generateData.messages;
        if (!Array.isArray(msgs)) {
            log('! 확인: 최종 메시지 목록이 배열이 아니라 확인하지 못함');
            return;
        }
        const text = request.text;
        const total = countAll(msgs, text);
        if (total > request.before) {
            const idx = lastIndexWith(msgs, text);
            const lastRole = msgs.length ? msgs[msgs.length - 1].role : '없음';
            log(`확인: 최종 전송본에 포함 (문장 ${total}회, 마지막 등장 ${idx + 1}/${msgs.length}번째, 맨 끝 역할 ${lastRole})`);
        } else {
            const at = Math.min(request.at, msgs.length);
            msgs.splice(at, 0, { role: 'user', content: text });
            log(`! 확인: 최종 전송본에서 빠져 있어 다시 추가 (문장 ${total}→${total + 1}회, ${at + 1}/${msgs.length}번째)`);
        }
    } catch (err) {
        reportError(err, '최종 프롬프트 확인');
    }
}

/* ---------- SillyTavern 이벤트 ---------- */
function onGenerationEnded() {
    endActive('끝');
    request = null;
}
function onGenerationStopped() {
    endActive('중지');
    request = null;
}
function onChatChanged() {
    logNote('채팅 전환');
    clearPending();
    clickEntry = null;
    activeEntry = null;
    request = null;
    groupRound.active = false;
    groupRound.valid = false;
}
function onGroupStarted() {
    log('그룹 라운드 시작');
    groupRound.active = true;
    groupRound.valid = false;
}
function onGroupFinished() {
    log('그룹 라운드 끝');
    groupRound.active = false;
    groupRound.valid = false;
}

function listen(name, fn) {
    if (!name) return;
    eventSource.on(name, (...args) => {
        try { fn(...args); } catch (err) { reportError(err, `이벤트 처리 (${name})`); }
    });
}

/* ---------- 설정 UI ---------- */
function updateStatus() {
    const el = document.getElementById('nm_status');
    if (!el) return;
    const s = settings();
    const hasPrompt = !!String(s.prompt || '').trim();
    let state = 'nm-off';                              // 빨강: 꺼짐
    if (s.enabled) state = hasPrompt ? 'nm-on' : 'nm-warn';   // 초록: 주입함 / 노랑: 켜져 있지만 프롬프트가 비어 주입 안 됨
    el.classList.remove('nm-on', 'nm-warn', 'nm-off');
    el.classList.add(state);
}

function renderPresets() {
    const sel = document.getElementById('nm_preset');
    if (!sel) return;
    const s = settings();
    sel.innerHTML = '';
    const add = (value, label) => {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = label;
        sel.appendChild(o);
    };
    add('', '직접 입력');
    for (const p of s.presets) add(p.id, p.name);
    sel.value = s.activePreset;
}

function buildUI() {
    if (document.querySelector('.nm-settings')) return;
    cleanPresets();
    const s = settings();
    const html = `
<div class="nm-settings inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header">
        <b>➡️ Next Message</b>
        <span id="nm_status" class="nm-status"></span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
        <label class="checkbox_label nm-check" for="nm_enabled">
            <input type="checkbox" id="nm_enabled">
            <span>활성화</span>
        </label>
        <div class="nm-preset-row">
            <select id="nm_preset" class="text_pole nm-select" aria-label="저장한 프롬프트 선택"></select>
            <div id="nm_save" class="menu_button nm-icon-btn" title="프롬프트 저장" aria-label="프롬프트 저장"><i class="fa-solid fa-floppy-disk"></i></div>
            <div id="nm_delete" class="menu_button nm-icon-btn" title="선택한 프롬프트 삭제" aria-label="선택한 프롬프트 삭제"><i class="fa-solid fa-trash"></i></div>
        </div>
        <textarea id="nm_prompt" class="text_pole nm-prompt" placeholder="빈 입력을 대체할 프롬프트를 넣어주세요."></textarea>
        <div class="nm-position-row">
            <label for="nm_position">주입 위치</label>
            <select id="nm_position" class="text_pole nm-select">
                <option value="end">맨 끝</option>
                <option value="before_prefill">프리필 앞</option>
                <option value="after_char">캐릭터 메세지 뒤</option>
            </select>
        </div>
        <div class="nm-icon-row">
            <div id="nm_reset" class="menu_button nm-icon-btn" title="기본값 복원" aria-label="기본값 복원"><i class="fa-solid fa-rotate-left"></i><span>기본값</span></div>
            <div id="nm_log_btn" class="menu_button nm-icon-btn" title="실행 기록" aria-label="실행 기록"><i class="fa-solid fa-clipboard-list"></i><span>실행 기록</span></div>
        </div>
        <div id="nm_log_wrap" class="nm-log-wrap">
            <textarea id="nm_log_text" class="text_pole nm-log" readonly></textarea>
            <div class="nm-icon-row">
                <div id="nm_copy" class="menu_button nm-icon-btn" title="복사" aria-label="복사"><i class="fa-solid fa-copy"></i><span>복사</span></div>
                <div id="nm_clear" class="menu_button nm-icon-btn" title="기록 지우기" aria-label="기록 지우기"><i class="fa-solid fa-eraser"></i><span>지우기</span></div>
            </div>
        </div>
    </div>
</div>`;
    const container = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!container) {
        console.warn('[Next Message] 확장 설정 영역을 찾지 못해 UI를 추가하지 못했습니다.');
        return;
    }
    $(container).append(html);

    $('#nm_enabled').prop('checked', !!s.enabled).on('change', function () {
        settings().enabled = $(this).prop('checked');
        saveSettingsDebounced();
        updateStatus();
    });
    $('#nm_position').val(s.position).on('change', function () {
        const v = String($(this).val());
        settings().position = POSITIONS.includes(v) ? v : 'before_prefill';
        saveSettingsDebounced();
    });
    $('#nm_prompt').val(s.prompt).on('input', function () {
        settings().prompt = String($(this).val());
        saveSettingsDebounced();
        updateStatus();
    });
    $('#nm_reset').on('click', () => {
        settings().prompt = DEFAULT_PROMPT;
        settings().activePreset = '';
        $('#nm_prompt').val(DEFAULT_PROMPT);
        renderPresets();
        saveSettingsDebounced();
        updateStatus();
    });
    $('#nm_preset').on('change', function () {
        applyPreset(String($(this).val()));
        $('#nm_prompt').val(settings().prompt);
        saveSettingsDebounced();
        updateStatus();
    });
    $('#nm_save').on('click', () => {
        const text = String($('#nm_prompt').val()).trim();
        if (!text) {
            toastr.warning('프롬프트가 비어 있어서 저장할 수 없습니다.');
            return;
        }
        const s = settings();
        const active = s.presets.find((p) => p.id === s.activePreset);
        const input = window.prompt('저장할 이름을 입력하세요. (같은 이름이면 덮어씁니다)', active ? active.name : '');
        if (input === null) return;
        const name = input.trim().slice(0, 40);
        if (!name) {
            toastr.warning('이름을 입력해 주세요.');
            return;
        }
        const other = s.presets.find((p) => p.name === name);
        if (other && other.id !== s.activePreset && !window.confirm(`'${name}'을(를) 덮어쓸까요?`)) return;
        upsertPreset(name, text);
        renderPresets();
        saveSettingsDebounced();
        toastr.success(`'${name}' 저장했습니다.`);
    });
    $('#nm_delete').on('click', () => {
        const s = settings();
        const active = s.presets.find((p) => p.id === s.activePreset);
        if (!active) {
            toastr.info('삭제할 프롬프트를 먼저 선택하세요.');
            return;
        }
        if (!window.confirm(`'${active.name}'을(를) 삭제할까요?`)) return;
        removePreset(active.id);
        renderPresets();
        saveSettingsDebounced();
        toastr.success('삭제했습니다.');
    });
    $('#nm_log_btn').on('click', () => {
        logOpen = !logOpen;
        $('#nm_log_wrap').toggle(logOpen);
        if (logOpen) renderLog();
    });
    $('#nm_copy').on('click', copyLog);
    $('#nm_clear').on('click', () => {
        logEntries.length = 0;
        activeEntry = null;
        clickEntry = null;
        if (logOpen) renderLog();
    });
    renderPresets();
    updateStatus();
}

jQuery(() => {
    try {
        settings();
        buildUI();
        document.addEventListener('click', onDocumentClick, true);

        listen(event_types.GENERATION_STARTED, onGenerationStarted);
        listen(event_types.CHAT_COMPLETION_PROMPT_READY, onPromptReady);
        listen(event_types.CHAT_COMPLETION_SETTINGS_READY, onSettingsReady);
        listen(event_types.GENERATION_ENDED, onGenerationEnded);
        listen(event_types.GENERATION_STOPPED, onGenerationStopped);
        listen(event_types.CHAT_CHANGED, onChatChanged);
        listen(event_types.GROUP_WRAPPER_STARTED, onGroupStarted);
        listen(event_types.GROUP_WRAPPER_FINISHED, onGroupFinished);

        logNote('확장 로드 완료');
    } catch (err) {
        console.error('[Next Message] 로드 실패', err);
    }
});
