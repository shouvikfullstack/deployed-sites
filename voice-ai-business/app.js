/**
 * Voice AI Softphone — Single screen with autocomplete language picker
 */
// Auto-detect WSS (via nginx /ws proxy) vs direct WS (local dev)
const _isSecure = location.protocol === 'https:';
const WS_URL = _isSecure
    ? `wss://${location.host}/ws`
    : `ws://${location.hostname || 'localhost'}:8765`;
const SAMPLE_RATE_MIC = 16000;
const SAMPLE_RATE_TTS = 24000;

const LANGUAGES = [
    { key: 'auto',      label: 'Auto-detect', native: 'Auto',     code: 'auto' },
    { key: 'hindi',     label: 'Hindi',     native: 'हिन्दी',    code: 'hi-IN' },
    { key: 'english',   label: 'English',   native: 'English',   code: 'en-IN' },
    { key: 'hinglish',  label: 'Hinglish',  native: 'हिन्दी+Eng', code: 'hi-IN' },
    { key: 'bengali',   label: 'Bengali',   native: 'বাংলা',     code: 'bn-IN' },
    { key: 'tamil',     label: 'Tamil',     native: 'தமிழ்',     code: 'ta-IN' },
    { key: 'telugu',    label: 'Telugu',    native: 'తెలుగు',    code: 'te-IN' },
    { key: 'marathi',   label: 'Marathi',   native: 'मराठी',     code: 'mr-IN' },
    { key: 'gujarati',  label: 'Gujarati',  native: 'ગુજરાતી',   code: 'gu-IN' },
    { key: 'kannada',   label: 'Kannada',   native: 'ಕನ್ನಡ',     code: 'kn-IN' },
    { key: 'malayalam', label: 'Malayalam', native: 'മലയാളം',   code: 'ml-IN' },
    { key: 'punjabi',   label: 'Punjabi',   native: 'ਪੰਜਾਬੀ',    code: 'pa-IN' },
];

// ---- State ----
let selectedLanguage = null;
let ws = null, audioContext = null, mediaStream = null, scriptProcessor = null;
let isInCall = false, isPlaying = false, isMuted = false;
let callStartTime = null, timerInterval = null;
let receivingAudio = false, playbackContext = null;
let nextPlayTime = 0, scheduledSources = [];
let highlightIdx = -1;

// ---- DOM ----
const langInput = document.getElementById('langInput');
const langDropdown = document.getElementById('langDropdown');
const langArrow = document.getElementById('langArrow');
const callBtn = document.getElementById('callBtn');
const callBtnLabel = document.getElementById('callBtnLabel');
const callStatus = document.getElementById('callStatus');
const callStatusText = document.getElementById('callStatusText');
const callTimer = document.getElementById('callTimer');
const waveform = document.getElementById('waveform');
const transcriptBody = document.getElementById('transcriptBody');
const turnCount = document.getElementById('turnCount');
const latencyDisplay = document.getElementById('latencyDisplay');
const intentBadge = document.getElementById('intentBadge');

// ---- Init ----
initWaveform();
renderDropdown(LANGUAGES);
// Auto-select "Auto-detect" so user can call immediately
selectLang(LANGUAGES[0]); // first item = auto-detect

// ========================================
// Autocomplete Language Picker
// ========================================
function renderDropdown(items) {
    langDropdown.innerHTML = '';
    highlightIdx = -1;
    if (items.length === 0) {
        const li = document.createElement('li');
        li.className = 'lang-option no-match';
        li.textContent = 'No match';
        langDropdown.appendChild(li);
        return;
    }
    items.forEach((lang, i) => {
        const li = document.createElement('li');
        li.className = 'lang-option';
        li.innerHTML = `<span class="lang-option-native">${lang.native}</span>
            <span class="lang-option-label">${lang.label}</span>
            <span class="lang-option-code">${lang.code}</span>`;
        li.addEventListener('mousedown', (e) => { e.preventDefault(); selectLang(lang); });
        langDropdown.appendChild(li);
    });
}

function openDropdown() {
    langDropdown.classList.add('open');
    langInput.parentElement.classList.add('open');
}
function closeDropdown() {
    langDropdown.classList.remove('open');
    langInput.parentElement.classList.remove('open');
    highlightIdx = -1;
}

function selectLang(lang) {
    selectedLanguage = lang.key;
    langInput.value = `${lang.native}  ${lang.label}`;
    langInput.dataset.key = lang.key;
    closeDropdown();
    // Enable call button
    callBtn.classList.remove('disabled');
    // If in call, notify server
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'set_language', language: lang.key }));
    }
}

langInput.addEventListener('focus', () => {
    if (isInCall) { isMuted = true; } // pause mic while picking
    langInput.dataset.prevText = langInput.value;  // save current display text
    langInput.value = '';                           // clear so full list shows
    renderDropdown(filterLangs(''));
    openDropdown();
});

langInput.addEventListener('input', () => {
    const q = langInput.value.trim();
    const filtered = filterLangs(q);
    renderDropdown(filtered);
    openDropdown();
    // If exact match typed, auto-select
    const exact = LANGUAGES.find(l =>
        l.label.toLowerCase() === q.toLowerCase() || l.key === q.toLowerCase()
    );
    if (exact) selectLang(exact);
    else { selectedLanguage = null; callBtn.classList.add('disabled'); }
});

langInput.addEventListener('blur', () => {
    setTimeout(() => {
        closeDropdown();
        if (isInCall) isMuted = false;
        // If nothing selected, reset; otherwise restore previous text if no new pick
        if (!selectedLanguage) {
            langInput.value = '';
        } else if (!langInput.value.trim()) {
            langInput.value = langInput.dataset.prevText || '';
        }
    }, 150);
});

langInput.addEventListener('keydown', (e) => {
    const options = langDropdown.querySelectorAll('.lang-option:not(.no-match)');
    if (e.key === 'ArrowDown') {
        e.preventDefault();
        highlightIdx = Math.min(highlightIdx + 1, options.length - 1);
        updateHighlight(options);
    } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        highlightIdx = Math.max(highlightIdx - 1, 0);
        updateHighlight(options);
    } else if (e.key === 'Enter') {
        e.preventDefault();
        if (highlightIdx >= 0 && options[highlightIdx]) {
            const key = filterLangs(langInput.value.trim())[highlightIdx]?.key;
            const lang = LANGUAGES.find(l => l.key === key);
            if (lang) selectLang(lang);
        }
    } else if (e.key === 'Tab') {
        // Tab selects first match
        const filtered = filterLangs(langInput.value.trim());
        if (filtered.length > 0) {
            e.preventDefault();
            selectLang(filtered[highlightIdx >= 0 ? highlightIdx : 0]);
        }
    } else if (e.key === 'Escape') {
        closeDropdown();
        langInput.blur();
    }
});

function updateHighlight(options) {
    options.forEach((o, i) => o.classList.toggle('highlighted', i === highlightIdx));
    if (options[highlightIdx]) options[highlightIdx].scrollIntoView({ block: 'nearest' });
}

function filterLangs(q) {
    if (!q) return LANGUAGES;
    const lower = q.toLowerCase();
    return LANGUAGES.filter(l =>
        l.label.toLowerCase().includes(lower) ||
        l.key.includes(lower) ||
        l.native.toLowerCase().includes(lower) ||
        l.code.toLowerCase().includes(lower)
    );
}

// ========================================
// Call Control
// ========================================
function toggleCall() {
    if (callBtn.classList.contains('disabled')) return;
    if (isInCall) endCall(); else startCall();
}

async function startCall() {
    if (!selectedLanguage) return;
    try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
            audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        // Try 16kHz AudioContext — if browser ignores, detect and resample
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE_MIC });
        const actualSR = audioContext.sampleRate;
        const sampleRateOK = (actualSR === SAMPLE_RATE_MIC);

        // Log critical audio config for debugging
        console.log(`%c[Audio Config]`, 'color: #4f8cff; font-weight: bold',
            `\n  Requested: ${SAMPLE_RATE_MIC}Hz`,
            `\n  Actual:    ${actualSR}Hz`,
            `\n  Match:     ${sampleRateOK ? 'YES' : 'NO — will resample'}`,
            `\n  Buffer:    8192 samples`);

        if (!sampleRateOK) {
            console.warn(`Browser gave ${actualSR}Hz instead of ${SAMPLE_RATE_MIC}Hz. Audio will be resampled — slight quality loss.`);
        }

        const source = audioContext.createMediaStreamSource(mediaStream);
        scriptProcessor = audioContext.createScriptProcessor(8192, 1, 1);

        let _chunkCount = 0;
        scriptProcessor.onaudioprocess = (e) => {
            if (!isInCall || !ws || ws.readyState !== WebSocket.OPEN || isMuted || isPlaying) return;
            const f32 = e.inputBuffer.getChannelData(0);

            // Resample if browser didn't give us 16kHz
            const samples = sampleRateOK ? f32 : resampleTo16k(f32, actualSR);

            // Audio quality check on first few chunks
            _chunkCount++;
            if (_chunkCount <= 3) {
                let sum = 0;
                for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
                const rms = Math.sqrt(sum / samples.length) * 32768;
                console.log(`[Audio Chunk ${_chunkCount}] samples=${samples.length} rms=${rms.toFixed(0)} rate=${sampleRateOK ? '16k native' : actualSR + '→16k resampled'}`);
            }

            const i16 = new Int16Array(samples.length);
            for (let i = 0; i < samples.length; i++) {
                const s = Math.max(-1, Math.min(1, samples[i]));
                i16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
            }
            ws.send(i16.buffer);
        };
        source.connect(scriptProcessor);
        scriptProcessor.connect(audioContext.destination);

        ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';
        ws.onopen = () => {
            isInCall = true;
            ws.send(JSON.stringify({ type: 'set_language', language: selectedLanguage }));
            setCallUI(true);
            startTimer();
            clearTranscript();
        };
        ws.onmessage = (ev) => {
            if (typeof ev.data === 'string') handleMsg(JSON.parse(ev.data));
            else if (receivingAudio && ev.data.byteLength > 0) playAudio(new Int16Array(ev.data));
        };
        ws.onclose = () => { if (isInCall) endCall(); };
        ws.onerror = () => addSystem('Connection error — is server running?');
    } catch (err) {
        addSystem('Mic error: ' + err.message);
    }
}

function endCall() {
    isInCall = false;
    if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
    if (audioContext) { audioContext.close(); audioContext = null; }
    if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
    if (ws) { ws.close(); ws = null; }
    stopTimer();
    resetPlayback();
    isMuted = false;
    setCallUI(false);
}

function setCallUI(active) {
    if (active) {
        callBtn.className = 'call-btn end';
        callBtn.textContent = '✕';
        callBtnLabel.textContent = 'End Call';
        callStatus.className = 'call-status active';
        callStatusText.textContent = 'Connected';
        langInput.classList.add('locked');
    } else {
        callBtn.className = 'call-btn start' + (selectedLanguage ? '' : ' disabled');
        callBtn.textContent = '📞';
        callBtnLabel.textContent = 'Call Clinic';
        callStatus.className = 'call-status';
        callStatusText.textContent = 'Ready to call';
        callTimer.textContent = '00:00';
        langInput.classList.remove('locked');
    }
}

// ---- WS Message Handlers ----
function handleMsg(m) {
    switch (m.type) {
        case 'greeting':
            addMsg('assistant', m.text);
            if (m.turn) turnCount.textContent = `Turn ${m.turn}`;
            break;
        case 'processing':
            showDots(); callStatus.className = 'call-status processing'; callStatusText.textContent = 'Processing...';
            break;
        case 'skipped':
            hideDots(); callStatus.className = 'call-status active'; callStatusText.textContent = 'Connected';
            break;
        case 'response':
            hideDots();
            addMsg('user', m.transcript);
            addMsg('assistant', m.response_text);
            updateEntities(m.entities);
            if (m.intent) intentBadge.textContent = m.intent.replace('_', ' ');
            if (m.timings) updateLatency(m.timings);
            if (m.turn) turnCount.textContent = `Turn ${m.turn}`;
            if (m.appointment) showApt(m.appointment);
            if (m.cost) updateCost(m.cost);
            // Show detected language in latency display when in auto mode
            if (m.language && selectedLanguage === 'auto') {
                const det = LANGUAGES.find(l => l.key === m.language);
                if (det) callStatusText.textContent = `Connected · ${det.native}`;
            }
            callStatus.className = 'call-status active';
            break;
        case 'audio_start': receivingAudio = true; resetPlayback(); break;
        case 'audio_end': receivingAudio = false; break;
        case 'mute': isMuted = true; break;
        case 'unmute': setTimeout(() => { isMuted = false; isPlaying = false; }, 300); break;
        case 'schedule':
            renderSchedule(m.doctors);
            break;
        case 'error': addSystem('Error: ' + m.message); break;
    }
}

// ---- Audio ----
function resampleTo16k(f32, fromRate) {
    if (fromRate === SAMPLE_RATE_MIC) return f32;
    const ratio = fromRate / SAMPLE_RATE_MIC;
    const len = Math.round(f32.length / ratio);
    const out = new Float32Array(len);
    for (let i = 0; i < len; i++) {
        const idx = i * ratio, lo = Math.floor(idx), hi = Math.min(lo + 1, f32.length - 1), frac = idx - lo;
        out[i] = f32[lo] * (1 - frac) + f32[hi] * frac;
    }
    return out;
}

function playAudio(i16) {
    if (!playbackContext || playbackContext.state === 'closed') playbackContext = new AudioContext();
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768.0;
    const buf = playbackContext.createBuffer(1, f32.length, SAMPLE_RATE_TTS);
    buf.getChannelData(0).set(f32);
    const src = playbackContext.createBufferSource();
    src.buffer = buf; src.connect(playbackContext.destination);
    const now = playbackContext.currentTime;
    const at = Math.max(now, nextPlayTime);
    nextPlayTime = at + buf.duration;
    isPlaying = true; waveform.classList.add('active');
    scheduledSources.push(src);
    src.onended = () => {
        scheduledSources = scheduledSources.filter(s => s !== src);
        if (!scheduledSources.length) { isPlaying = false; waveform.classList.remove('active'); }
    };
    src.start(at);
}
function resetPlayback() {
    scheduledSources.forEach(s => { try { s.stop(); } catch(e) {} });
    scheduledSources = []; nextPlayTime = 0; isPlaying = false; waveform.classList.remove('active');
}

// ---- UI Helpers ----
function initWaveform() {
    waveform.innerHTML = '';
    for (let i = 0; i < 28; i++) {
        const b = document.createElement('div');
        b.className = 'bar';
        b.style.setProperty('--h', `${10 + Math.random() * 30}px`);
        b.style.animationDelay = `${Math.random() * .6}s`;
        waveform.appendChild(b);
    }
}
function clearTranscript() {
    transcriptBody.innerHTML = '';
    document.querySelectorAll('.entity-item').forEach(el => {
        el.classList.remove('filled'); el.querySelector('.entity-value').textContent = 'Not provided';
    });
    document.getElementById('appointmentCard').classList.remove('visible');
    intentBadge.textContent = '—'; latencyDisplay.textContent = '—'; turnCount.textContent = 'Turn 0';
    resetCost();
}
function addMsg(role, text) {
    const d = document.createElement('div'); d.className = `message ${role}`; d.textContent = text;
    transcriptBody.appendChild(d); transcriptBody.scrollTop = transcriptBody.scrollHeight;
}
function addSystem(text) {
    const d = document.createElement('div'); d.className = 'message assistant';
    d.style.opacity = '.6'; d.style.fontStyle = 'italic'; d.textContent = text;
    transcriptBody.appendChild(d); transcriptBody.scrollTop = transcriptBody.scrollHeight;
}
function showDots() {
    hideDots();
    const d = document.createElement('div'); d.className = 'processing-indicator'; d.id = 'dots';
    d.innerHTML = '<span></span><span></span><span></span>';
    transcriptBody.appendChild(d); transcriptBody.scrollTop = transcriptBody.scrollHeight;
}
function hideDots() { const e = document.getElementById('dots'); if (e) e.remove(); }
function updateEntities(ents) {
    for (const [k, v] of Object.entries(ents)) {
        const el = document.querySelector(`.entity-item[data-entity="${k}"]`);
        if (el && v) { el.classList.add('filled'); el.querySelector('.entity-value').textContent = v; }
    }
}
function updateLatency(t) {
    const parts = [];
    if (t.stt_ms) parts.push(`STT ${t.stt_ms}ms`);
    if (t.understand_ms) parts.push(`NLU ${t.understand_ms}ms`);
    if (t.response_ms) parts.push(`Gen ${t.response_ms}ms`);
    if (t.total_ms) parts.push(`Total ${t.total_ms}ms`);
    const lang = LANGUAGES.find(l => l.key === selectedLanguage);
    if (lang) parts.push(lang.code);
    latencyDisplay.textContent = parts.join(' | ');
}
function showApt(a) {
    document.getElementById('aptDoctor').textContent = a.doctor_name || '—';
    document.getElementById('aptDate').textContent = a.date || '—';
    document.getElementById('aptTime').textContent = a.time || '—';
    document.getElementById('aptId').textContent = a.id || '—';
    document.getElementById('appointmentCard').classList.add('visible');
}
function startTimer() {
    callStartTime = Date.now();
    timerInterval = setInterval(() => {
        const s = Math.floor((Date.now() - callStartTime) / 1000);
        callTimer.textContent = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    }, 1000);
}
function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } }
function updateCost(c) {
    if (!c) return;
    const subtotal = c.call_total_inr || 0;
    const gst = subtotal * 0.18;
    const total = subtotal + gst;
    const usd = total / 83;

    document.getElementById('costStt').textContent = '₹' + (c.cum_stt || 0).toFixed(3);
    document.getElementById('costLlm').textContent = '₹' + (c.cum_llm || 0).toFixed(3);
    document.getElementById('costTts').textContent = '₹' + (c.cum_tts || 0).toFixed(3);
    document.getElementById('costSubtotal').textContent = '₹' + subtotal.toFixed(3);
    document.getElementById('costGst').textContent = '₹' + gst.toFixed(3);
    document.getElementById('costTotal').textContent = '₹' + total.toFixed(3);
    document.getElementById('costUsd').textContent = '$' + usd.toFixed(4);
}
function resetCost() {
    ['costStt','costLlm','costTts','costSubtotal','costGst'].forEach(id =>
        document.getElementById(id).textContent = '₹0.000');
    document.getElementById('costTotal').textContent = '₹0.000';
    document.getElementById('costUsd').textContent = '$0.0000';
}

// ========================================
// Tabs + Schedule
// ========================================
function switchTab(tabName) {
    document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
}

function renderSchedule(doctors) {
    const list = document.getElementById('scheduleList');
    if (!doctors || !doctors.length) { list.innerHTML = '<div class="empty-state">No schedule data</div>'; return; }

    list.innerHTML = '';
    doctors.forEach((doc, i) => {
        const div = document.createElement('div');
        div.className = 'sched-doctor' + (i === 0 ? ' open' : '');

        let daysHtml = '';
        for (const [dayLabel, info] of Object.entries(doc.schedule)) {
            const slotsHtml = info.slots.length
                ? info.slots.map(s => `<span class="sched-slot">${s}</span>`).join('')
                : '<span class="sched-no-slots">No slots</span>';
            const extra = info.total > info.slots.length ? `<span class="sched-no-slots"> +${info.total - info.slots.length} more</span>` : '';
            daysHtml += `<div class="sched-day">
                <div class="sched-day-label">${dayLabel}</div>
                <div class="sched-slots">${slotsHtml}${extra}</div>
            </div>`;
        }

        div.innerHTML = `
            <div class="sched-doctor-header" onclick="this.parentElement.classList.toggle('open')">
                <div>
                    <div class="sched-doc-name">${doc.name}</div>
                    <div class="sched-doc-spec">${doc.specialty}</div>
                </div>
                <span class="sched-toggle">&#9662;</span>
            </div>
            <div class="sched-days">${daysHtml}</div>
        `;
        list.appendChild(div);
    });
}
