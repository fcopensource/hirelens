const $ = (selector) => document.querySelector(selector);
const csrfToken = document.querySelector("[name=csrfmiddlewaretoken]")?.value || "";
const MEDIAPIPE_VERSION = "0.10.35";
const VISION_MODEL_VERSION = "adaptive-local-v1.2-full-pose";
const VISION_CALIBRATION_MS = 10000;
const VISION_HISTORY_MS = 90000;
const REALTIME_MINI_RATES = {
  textInput: .60,
  textCached: .06,
  textOutput: 2.40,
  audioInput: 10,
  audioCached: .30,
  audioOutput: 20,
};
const MEDIAPIPE_SOURCES = [
  {
    module: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/+esm`,
    wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  },
  {
    module: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
    wasm: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`,
  },
];

const state = {
  interviewId: null,
  stream: null,
  peer: null,
  channel: null,
  remoteAudio: null,
  remoteAudioContext: null,
  remoteAudioSource: null,
  remoteAudioAnalyser: null,
  remoteAudioTimeData: null,
  remoteAudioFrequencyData: null,
  remoteAudioStreamId: null,
  voiceEnergy: 0,
  voiceBrightness: 0,
  realtimeConnected: false,
  fallback: false,
  fallbackQuestion: "",
  startedAt: null,
  timer: null,
  voiceEnabled: true,
  micEnabled: true,
  cameraEnabled: true,
  captionsEnabled: true,
  candidateSpeaking: false,
  mayaSpeaking: false,
  candidateDraft: "",
  mayaDraft: "",
  suppressMayaTurn: false,
  activeVisionCue: false,
  eventCount: 0,
  turnCount: 0,
  completing: false,
  listenersBound: false,
  fullscreenRequired: false,
  integrityKind: "",
  integrityReason: "",
  integrityDeadline: 0,
  integrityTimer: null,
  integrityWarningTimer: null,
  completionReason: "candidate_ended",
  faceLandmarker: null,
  poseLandmarker: null,
  handLandmarker: null,
  visionRunning: false,
  lastFaceRun: 0,
  lastPoseRun: 0,
  lastHandRun: 0,
  lastClarityRun: 0,
  lastPosePoints: null,
  lastFaceResult: null,
  lastPoseResult: null,
  lastHandResult: null,
  poseHandsVisible: false,
  poseHandCount: 0,
  upperBodyVisibleFrames: 0,
  upperBodyMissingFrames: 0,
  stableUpperBodyVisible: false,
  handPresenceEma: 0,
  stableHandCount: 0,
  pendingHandCount: 0,
  handVisibleFrames: 0,
  handMissingFrames: 0,
  shoulderTiltEma: 0,
  bodyCenterEma: .5,
  headYawEma: 0,
  headPitchEma: .45,
  gazeSideEma: 0,
  visionConfidence: .5,
  motionEma: 0,
  visionFrames: 0,
  visionFpsAt: 0,
  inferenceCostEma: 0,
  conditions: new Map(),
  cooldowns: new Map(),
  dismissedCues: new Set(),
  visionCueCooldown: 0,
  pendingVisionCue: null,
  visionCueTimer: null,
  activeCoachingKind: "",
  coachingTimer: null,
  calibrationStartedAt: 0,
  calibrationComplete: false,
  calibrationBaseline: {},
  visionHistory: {
    face: [],
    shoulders: [],
    posture: [],
    hands: [],
    gaze: [],
    clarity: [],
  },
  visionFrameTotal: 0,
  visionTelemetryStartedAt: 0,
  visionTelemetryTimer: null,
  visionContextTimer: null,
  lastVisionContextSignature: "",
  lastVisionContextAt: 0,
  currentFaceCount: 0,
  detectedHandCount: 0,
  currentGazeAligned: true,
  realtimeUsage: {
    input_text_tokens: 0,
    input_audio_tokens: 0,
    cached_text_tokens: 0,
    cached_audio_tokens: 0,
    output_text_tokens: 0,
    output_audio_tokens: 0,
    responses: 0,
  },
  usageResponseIds: new Set(),
  recoveringTruncation: false,
  avatar: null,
  interviewerStyle: "female",
  interviewerName: "Maya",
  recognition: null,
  maxSeconds: Math.max(5, Number(document.body.dataset.maxMinutes || 25)) * 60,
  warnedTimeLimit: false,
};

const setupView = $("#setupView");
const interviewView = $("#interviewView");
const completeView = $("#completeView");
const preflightVideo = $("#preflightVideo");
const candidateVideo = $("#candidateVideo");

function refreshIcons() {
  if (window.lucide) window.lucide.createIcons({ attrs: { "stroke-width": 1.8 } });
}
window.addEventListener("load", refreshIcons);

async function api(url, options = {}) {
  const headers = { "X-CSRFToken": csrfToken, ...(options.headers || {}) };
  if (!(options.body instanceof FormData) && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(url, { ...options, headers });
  let payload = {};
  try {
    payload = await response.json();
  } catch {
    payload = { error: "The server returned an unreadable response." };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || "Something went wrong. Please try again.");
  }
  return payload;
}

function toast(message, warning = false) {
  const node = document.createElement("div");
  node.className = `toast${warning ? " warning" : ""}`;
  node.innerHTML = `<i data-lucide="${warning ? "triangle-alert" : "check-circle-2"}"></i><span></span>`;
  node.querySelector("span").textContent = message;
  $("#toastStack").appendChild(node);
  refreshIcons();
  setTimeout(() => node.remove(), 4500);
}

async function requestProtectedFullscreen() {
  if (!document.fullscreenEnabled || document.fullscreenElement) return true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    try {
      await document.documentElement.requestFullscreen();
      return true;
    } catch {
      return false;
    }
  }
}

function setDeviceStatus(device, ok, detail) {
  const row = document.querySelector(`[data-device="${device}"]`);
  if (!row) return;
  row.querySelector("small").textContent = detail;
  const icon = row.querySelector(".device-state");
  icon.outerHTML = `<i data-lucide="${ok ? "check-circle-2" : "circle-x"}" class="device-state ${ok ? "ok" : "bad"}"></i>`;
  refreshIcons();
}

async function getUserMediaWithTimeout(constraints, timeoutMs = 15000) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("media_unsupported");
  }
  let expired = false;
  let timeoutId;
  const pending = navigator.mediaDevices.getUserMedia(constraints);
  pending.then((stream) => {
    if (expired) stream.getTracks().forEach((track) => track.stop());
  }).catch(() => {});
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      expired = true;
      reject(new Error("permission_timeout"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function checkDevices() {
  $("#setupError").textContent = "";
  const button = $("#checkDevices");
  button.disabled = true;
  button.innerHTML = '<i data-lucide="loader-circle"></i> Requesting access…';
  refreshIcons();
  try {
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = await getUserMediaWithTimeout({
      video: {
        width: { ideal: 1280 },
        height: { ideal: 720 },
        facingMode: "user",
        frameRate: { ideal: 24, max: 30 },
      },
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    preflightVideo.srcObject = state.stream;
    candidateVideo.srcObject = state.stream;
    $("#cameraPlaceholder").hidden = true;
    setDeviceStatus("camera", Boolean(state.stream.getVideoTracks().length), "Camera connected");
    setDeviceStatus("microphone", Boolean(state.stream.getAudioTracks().length), "Microphone connected");
    toast("Camera and microphone are ready.");
    return true;
  } catch (deviceError) {
    setDeviceStatus("camera", false, "Access denied or unavailable");
    setDeviceStatus("microphone", false, "Access denied or unavailable");
    $("#setupError").textContent = deviceError?.message === "permission_timeout"
      ? "Camera permission is still waiting. Open the camera icon in your browser address bar, choose Allow, then try again."
      : "Allow camera and microphone access in your browser, then try again.";
    return false;
  } finally {
    button.disabled = false;
    button.innerHTML = '<i data-lucide="refresh-cw"></i> Check camera & microphone';
    refreshIcons();
  }
}

$("#checkDevices").addEventListener("click", checkDevices);

const resumeInput = $("#resumeFile");
const resumeDrop = $("#resumeDrop");
function showResume(file) {
  if (!file) {
    $("#resumeTitle").textContent = "Add your resume";
    $("#resumeHint").textContent = "PDF, DOCX or TXT · up to 5 MB";
    return;
  }
  $("#resumeTitle").textContent = file.name;
  $("#resumeHint").textContent = `${(file.size / 1024 / 1024).toFixed(2)} MB · ready to use`;
}
resumeInput.addEventListener("change", () => showResume(resumeInput.files[0]));
["dragenter", "dragover"].forEach((name) => resumeDrop.addEventListener(name, (event) => {
  event.preventDefault();
  resumeDrop.classList.add("dragging");
}));
["dragleave", "drop"].forEach((name) => resumeDrop.addEventListener(name, (event) => {
  event.preventDefault();
  resumeDrop.classList.remove("dragging");
}));
resumeDrop.addEventListener("drop", (event) => {
  const file = event.dataTransfer.files[0];
  if (!file) return;
  const transfer = new DataTransfer();
  transfer.items.add(file);
  resumeInput.files = transfer.files;
  showResume(file);
});

$("#setupForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const error = $("#setupError");
  error.textContent = "";
  const name = $("#candidateName").value.trim();
  const role = $("#targetRole").value.trim();
  if (!name || !role) {
    error.textContent = "Enter your name and the role before continuing.";
    return;
  }
  if (!$("#consent").checked) {
    error.textContent = "Please review and accept the camera and microphone consent.";
    return;
  }
  const button = $("#startButton");
  button.disabled = true;
  const selectedStyle = new FormData(formElement).get("interviewer_style") === "male" ? "male" : "female";
  state.interviewerStyle = selectedStyle;
  state.interviewerName = selectedStyle === "male" ? "Arjun" : "Maya";
  try {
    if (!state.stream?.active) {
      button.querySelector("span").textContent = "Preparing camera…";
      if (!(await checkDevices())) return;
    }

    const fullscreenSupported = Boolean(document.fullscreenEnabled);
    const fullscreenReady = !fullscreenSupported
      || Boolean(document.fullscreenElement)
      || await requestProtectedFullscreen();
    state.fullscreenRequired = fullscreenSupported && fullscreenReady;
    if (fullscreenSupported && !fullscreenReady) {
      toast("Fullscreen was unavailable, so the interview will continue with focus monitoring.", true);
    }

    button.querySelector("span").textContent = `${state.interviewerName} is joining…`;
    const form = new FormData(formElement);
    form.set("consent", "true");
    form.set("realtime", "true");
    const payload = await api("/api/interviews/start/", { method: "POST", body: form });
    state.interviewId = payload.interview_id;
    state.interviewerStyle = payload.interviewer_style === "male" ? "male" : "female";
    state.interviewerName = payload.interviewer_name || (state.interviewerStyle === "male" ? "Arjun" : "Maya");
    state.fallbackQuestion = payload.question;
    state.startedAt = Date.now();
    state.maxSeconds = Math.max(5, Number(payload.max_minutes || document.body.dataset.defaultMinutes || 12)) * 60;
    $("#roleLabel").textContent = role;
    $("#candidateLabel").textContent = name;
    $("#candidateInitial").textContent = (name[0] || "Y").toUpperCase();
    $("#completeName").textContent = name.split(/\s+/)[0];
    $("#sessionModeLabel").textContent = $("#sessionMode").value === "practice" ? "Practice & learn" : "Interview";
    updateInterviewerUi();
    setupView.hidden = true;
    interviewView.hidden = false;
    candidateVideo.srcObject = state.stream;
    candidateVideo.play().catch(() => {});
    startSessionTimer();
    bindIntegrityListeners();
    initAvatar();
    initVision();
    await connectRealtime(payload);
  } catch (requestError) {
    error.textContent = requestError.message;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  } finally {
    button.disabled = false;
    button.querySelector("span").textContent = "Join live interview";
  }
});

function updateInterviewerUi() {
  const name = state.interviewerName;
  const initial = name.charAt(0).toUpperCase();
  $("#liveInterviewerLabel").textContent = `LIVE WITH ${name.toUpperCase()}`;
  $("#interviewerName").textContent = name;
  $("#interviewerInitial").textContent = initial;
  $("#studioName").textContent = `${name} Studio`;
  $("#captionSpeaker strong").textContent = name;
  $("#activeCaption").textContent = `${name} is joining the room…`;
  $("#fallbackQuestion").textContent = `${name}’s question`;
  $("#textMessage").placeholder = `Type a message to ${name}…`;
  $("#avatarCanvas").setAttribute("aria-label", `Animated 3D interviewer ${name}`);
  $("#avatarFallback").dataset.style = state.interviewerStyle;
}

function startSessionTimer() {
  clearInterval(state.timer);
  const tick = () => {
    const elapsed = Math.floor((Date.now() - state.startedAt) / 1000);
    $("#sessionTimer").textContent = formatDuration(elapsed);
    if (!state.warnedTimeLimit && elapsed >= state.maxSeconds - 120) {
      state.warnedTimeLimit = true;
      toast("Two minutes remain in this session.", true);
    }
    if (elapsed >= state.maxSeconds && !state.completing) {
      toast("The session time limit was reached. Preparing your recap.");
      completeInterview("time_limit");
    }
  };
  tick();
  state.timer = setInterval(tick, 1000);
}

function formatDuration(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function setConnection(label, mode = "") {
  const badge = $("#connectionBadge");
  badge.className = `connection-pill ${mode}`;
  badge.innerHTML = `<span></span>${label}`;
}

async function connectRealtime(payload) {
  if (!payload.realtime_available || !window.RTCPeerConnection) {
    activateFallback(payload.question, "Live voice is not configured; text and browser voice are active.");
    return;
  }
  try {
    const peer = new RTCPeerConnection();
    state.peer = peer;
    state.remoteAudio = document.createElement("audio");
    state.remoteAudio.autoplay = true;
    peer.ontrack = (event) => {
      state.remoteAudio.srcObject = event.streams[0];
      state.remoteAudio.muted = !state.voiceEnabled;
      state.remoteAudio.play().catch(() => {});
      attachRemoteAudioAnalysis(event.streams[0]);
    };
    state.stream.getAudioTracks().forEach((track) => peer.addTrack(track, state.stream));
    const channel = peer.createDataChannel("oai-events");
    state.channel = channel;
    channel.addEventListener("message", (event) => {
      try { handleRealtimeEvent(JSON.parse(event.data)); } catch { /* Ignore malformed events. */ }
    });
    channel.addEventListener("open", () => {
      state.realtimeConnected = true;
      setConnection("Live voice connected", "connected");
      $("#speakingState").innerHTML = '<i data-lucide="ear"></i> Listening';
      refreshIcons();
      clearInterval(state.visionContextTimer);
      state.visionContextTimer = setInterval(syncVisionContext, 4000);
      syncVisionContext(true);
      sendEvent({
        type: "response.create",
        response: {
          instructions: "Greet the candidate by first name and immediately ask one complete, relevant interview question. Use no preamble and finish the sentence.",
        },
      });
    });
    channel.addEventListener("close", () => {
      if (!state.completing && !state.fallback) activateFallback(state.fallbackQuestion, "The live connection ended. Text fallback is ready.");
    });
    peer.addEventListener("connectionstatechange", () => {
      if (peer.connectionState === "failed" && !state.fallback) {
        activateFallback(state.fallbackQuestion, "Live voice lost connection. Text fallback is ready.");
      }
    });
    const offer = await peer.createOffer();
    await peer.setLocalDescription(offer);
    const response = await fetch(`/api/interviews/${state.interviewId}/realtime/`, {
      method: "POST",
      body: offer.sdp,
      headers: { "Content-Type": "application/sdp", "X-CSRFToken": csrfToken },
    });
    if (!response.ok) {
      let message = "Live voice could not start.";
      try { message = (await response.json()).error || message; } catch { /* SDP errors may be text. */ }
      throw new Error(message);
    }
    await peer.setRemoteDescription({ type: "answer", sdp: await response.text() });
  } catch (error) {
    state.peer?.close();
    state.peer = null;
    activateFallback(payload.question, `${error.message} Text fallback is ready.`);
  }
}

function sendEvent(event) {
  if (state.channel?.readyState !== "open") return false;
  state.channel.send(JSON.stringify(event));
  return true;
}

function currentVisionContext() {
  const confidence = Math.round(state.visionConfidence * 100);
  const eyeStatus = $("#eyeStatus")?.textContent || "unknown";
  return {
    face_count: state.currentFaceCount,
    eyes: eyeStatus,
    upper_body_visible: state.stableUpperBodyVisible,
    hand_landmarks: state.detectedHandCount,
    wrist_proxy_count: state.poseHandCount,
    movement: $("#motionValue")?.textContent || "unknown",
    tracking_confidence_percent: confidence,
  };
}

function syncVisionContext(force = false) {
  if (!state.realtimeConnected || state.completing || !state.calibrationComplete) return;
  const snapshot = currentVisionContext();
  const signature = JSON.stringify(snapshot);
  const now = Date.now();
  if (!force && signature === state.lastVisionContextSignature && now - state.lastVisionContextAt < 20000) return;
  const sent = sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{
        type: "input_text",
        text: (
          `[LOCAL_VISIBILITY_STATUS — telemetry, not candidate speech: ${signature}. `
          + "Use only for neutral camera setup or if the candidate asks what is visible. "
          + "Describe this as local tracker output, never direct human vision, cheating evidence, or evaluation.]"
        ),
      }],
    },
  });
  if (sent) {
    state.lastVisionContextSignature = signature;
    state.lastVisionContextAt = now;
  }
}

function handleRealtimeEvent(event) {
  const type = event.type || "";
  if (type === "input_audio_buffer.speech_started") {
    state.candidateSpeaking = true;
    state.candidateDraft = "";
    document.querySelector(".candidate-tile")?.classList.add("speaking");
    $("#speakingState").innerHTML = '<i data-lucide="ear"></i> Listening';
    refreshIcons();
  }
  if (type === "input_audio_buffer.speech_stopped") {
    state.candidateSpeaking = false;
    document.querySelector(".candidate-tile")?.classList.remove("speaking");
    setTimeout(flushVisionCue, 500);
  }

  if (type === "conversation.item.input_audio_transcription.delta") {
    state.candidateDraft += event.delta || "";
    showCaption("candidate", state.candidateDraft);
  }
  if (type === "conversation.item.input_audio_transcription.completed") {
    const text = (event.transcript || state.candidateDraft).trim();
    state.candidateDraft = "";
    if (text) commitTurn("candidate", text);
  }

  if (type === "response.created" || type === "response.output_audio.delta") setMayaSpeaking(true);
  if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
    state.mayaDraft += event.delta || "";
    showCaption("maya", state.mayaDraft);
    setMayaSpeaking(true);
  }
  if (type === "response.output_audio_transcript.done" || type === "response.audio_transcript.done") {
    const text = (event.transcript || state.mayaDraft).trim();
    state.mayaDraft = "";
    if (text && !state.suppressMayaTurn) commitTurn("interviewer", text);
    state.suppressMayaTurn = false;
    state.activeVisionCue = false;
  }
  if (type === "response.done") {
    const response = event.response || {};
    accumulateRealtimeUsage(response);
    handleResponseOutcome(response);
    setMayaSpeaking(false);
    state.activeVisionCue = false;
    if (!state.mayaDraft) setTimeout(() => {
      if (!state.mayaSpeaking) showCaption("maya", "I’m listening.");
    }, 1800);
    setTimeout(flushVisionCue, 650);
  }
  if (type === "error") {
    toast(event.error?.message || `${state.interviewerName} had trouble responding. Please try again.`, true);
  }
}

function handleResponseOutcome(response = {}) {
  const status = response.status || "";
  const reason = response.status_details?.reason || "";
  const purpose = response.metadata?.response_purpose || "";
  const isRecovery = purpose === "truncation_recovery";
  if (isRecovery) state.recoveringTruncation = false;
  if (
    status === "incomplete"
    && reason === "max_output_tokens"
    && purpose !== "visual_setup"
    && !isRecovery
    && !state.recoveringTruncation
    && !state.completing
  ) {
    state.recoveringTruncation = true;
    setTimeout(() => {
      const sent = sendEvent({
        type: "response.create",
        response: {
          max_output_tokens: 160,
          metadata: { response_purpose: "truncation_recovery" },
          instructions: (
            "Your previous spoken sentence was cut off. Continue exactly where "
            + "it stopped, complete only that sentence in at most 18 words, "
            + "then stop. Do not restart, apologize, or ask another question."
          ),
        },
      });
      if (!sent) state.recoveringTruncation = false;
    }, 220);
    return;
  }
  if (status === "incomplete" && reason === "content_filter") {
    toast(`${state.interviewerName} could not finish that response. Please continue with the interview.`, true);
  } else if (status === "failed") {
    toast(`${state.interviewerName}’s response was interrupted. Please ask them to continue.`, true);
  }
}

function accumulateRealtimeUsage(response = {}) {
  const responseId = response.id || "";
  if (responseId && state.usageResponseIds.has(responseId)) return;
  if (responseId) state.usageResponseIds.add(responseId);
  const usage = response.usage || {};
  const input = usage.input_token_details || {};
  const cached = input.cached_tokens_details || {};
  const output = usage.output_token_details || {};
  const additions = {
    input_text_tokens: Number(input.text_tokens || 0),
    input_audio_tokens: Number(input.audio_tokens || 0),
    cached_text_tokens: Number(cached.text_tokens || 0),
    cached_audio_tokens: Number(cached.audio_tokens || 0),
    output_text_tokens: Number(output.text_tokens || 0),
    output_audio_tokens: Number(output.audio_tokens || 0),
  };
  Object.entries(additions).forEach(([key, value]) => {
    state.realtimeUsage[key] += Math.max(0, Math.round(value));
  });
  state.realtimeUsage.responses += 1;
  updateUsageUi();
}

function realtimeTokenTotal() {
  const usage = state.realtimeUsage;
  return usage.input_text_tokens
    + usage.input_audio_tokens
    + usage.output_text_tokens
    + usage.output_audio_tokens;
}

function estimatedRealtimeCost() {
  const model = document.body.dataset.realtimeModel || "";
  if (!model.includes("gpt-realtime-2.1-mini")) return null;
  const usage = state.realtimeUsage;
  const cachedText = Math.min(usage.cached_text_tokens, usage.input_text_tokens);
  const cachedAudio = Math.min(usage.cached_audio_tokens, usage.input_audio_tokens);
  return (
    (usage.input_text_tokens - cachedText) * REALTIME_MINI_RATES.textInput
    + cachedText * REALTIME_MINI_RATES.textCached
    + (usage.input_audio_tokens - cachedAudio) * REALTIME_MINI_RATES.audioInput
    + cachedAudio * REALTIME_MINI_RATES.audioCached
    + usage.output_text_tokens * REALTIME_MINI_RATES.textOutput
    + usage.output_audio_tokens * REALTIME_MINI_RATES.audioOutput
  ) / 1_000_000;
}

function usageLabel() {
  const tokens = realtimeTokenTotal();
  const cost = estimatedRealtimeCost();
  const tokenLabel = `${tokens.toLocaleString()} tokens`;
  return cost === null ? tokenLabel : `~$${cost < .01 ? cost.toFixed(4) : cost.toFixed(3)} · ${tokenLabel}`;
}

function updateUsageUi() {
  const label = usageLabel();
  $("#usageMeter strong").textContent = label;
  $("#finalUsage").textContent = label;
}

function setMayaSpeaking(speaking) {
  state.mayaSpeaking = speaking;
  $("#mayaGlow").classList.toggle("active", speaking);
  document.querySelector(".interviewer-tile")?.classList.toggle("speaking", speaking);
  $("#speakingState").innerHTML = speaking
    ? '<i data-lucide="audio-lines"></i> Speaking'
    : '<i data-lucide="ear"></i> Listening';
  refreshIcons();
}

function attachRemoteAudioAnalysis(stream) {
  if (!stream || state.remoteAudioStreamId === stream.id) return;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  try {
    state.remoteAudioSource?.disconnect();
    if (!state.remoteAudioContext || state.remoteAudioContext.state === "closed") {
      state.remoteAudioContext = new AudioContextClass({ latencyHint: "interactive" });
    }
    const analyser = state.remoteAudioContext.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = .38;
    state.remoteAudioSource = state.remoteAudioContext.createMediaStreamSource(stream);
    state.remoteAudioSource.connect(analyser);
    state.remoteAudioAnalyser = analyser;
    state.remoteAudioTimeData = new Uint8Array(analyser.fftSize);
    state.remoteAudioFrequencyData = new Uint8Array(analyser.frequencyBinCount);
    state.remoteAudioStreamId = stream.id;
    state.remoteAudioContext.resume().catch(() => {});
  } catch {
    state.remoteAudioAnalyser = null;
  }
}

function sampleMayaVoice() {
  const analyser = state.remoteAudioAnalyser;
  const timeData = state.remoteAudioTimeData;
  const frequencyData = state.remoteAudioFrequencyData;
  let targetEnergy = 0;
  let targetBrightness = 0;
  if (analyser && timeData && frequencyData) {
    analyser.getByteTimeDomainData(timeData);
    let sumSquares = 0;
    for (const sample of timeData) {
      const normalized = (sample - 128) / 128;
      sumSquares += normalized * normalized;
    }
    const rms = Math.sqrt(sumSquares / timeData.length);
    targetEnergy = Math.min(1, Math.max(0, (rms - .008) * 13));

    analyser.getByteFrequencyData(frequencyData);
    let weighted = 0;
    let total = 0;
    frequencyData.forEach((value, index) => {
      weighted += value * index;
      total += value;
    });
    const centroid = total ? weighted / total / frequencyData.length : 0;
    targetBrightness = Math.min(1, Math.max(0, (centroid - .08) * 3.2));
  } else if (state.fallback && state.mayaSpeaking) {
    targetEnergy = .24 + Math.abs(Math.sin(performance.now() * .014)) * .34;
    targetBrightness = .35;
  }
  const energySpeed = targetEnergy > state.voiceEnergy ? .58 : .22;
  state.voiceEnergy += (targetEnergy - state.voiceEnergy) * energySpeed;
  state.voiceBrightness += (targetBrightness - state.voiceBrightness) * .2;
  if (!state.mayaSpeaking && targetEnergy < .025) state.voiceEnergy *= .72;
  return { energy: state.voiceEnergy, brightness: state.voiceBrightness };
}

function showCaption(speaker, text) {
  const rail = $("#captionRail");
  const speakerNode = $("#captionSpeaker");
  const clean = String(text || "").trim();
  $("#activeCaption").textContent = clean;
  speakerNode.className = `caption-speaker ${speaker}`;
  speakerNode.querySelector("strong").textContent = speaker === "maya" ? state.interviewerName : "You";
  rail.classList.toggle("candidate", speaker === "candidate");
  rail.hidden = !state.captionsEnabled || !clean;
}

function appendTurn(speaker, text) {
  const feed = $("#conversationFeed");
  feed.querySelector(".empty-feed")?.remove();
  const item = document.createElement("div");
  item.className = `turn ${speaker}`;
  item.innerHTML = `<span>${speaker === "candidate" ? "YOU" : state.interviewerName.toUpperCase()}</span><p></p>`;
  item.querySelector("p").textContent = text;
  feed.appendChild(item);
  feed.scrollTop = feed.scrollHeight;
  state.turnCount += 1;
}

function commitTurn(speaker, text) {
  appendTurn(speaker, text);
  api(`/api/interviews/${state.interviewId}/transcript/`, {
    method: "POST",
    body: JSON.stringify({ speaker, text }),
  }).catch(() => toast("A transcript turn could not be saved.", true));
}

function sendRealtimeText(text, vision = false) {
  const clean = text.trim();
  if (!clean || !state.realtimeConnected) return false;
  if (vision) {
    state.suppressMayaTurn = true;
    state.activeVisionCue = true;
    return sendEvent({
      type: "response.create",
      response: {
        conversation: "none",
        max_output_tokens: 80,
        metadata: { response_purpose: "visual_setup" },
        instructions: (
          `You are ${state.interviewerName}. Say one short, calm camera-setup sentence using the `
          + "provided note. Do not evaluate the candidate, repeat a question, "
          + "or add this note to the interview."
        ),
        input: [{
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: clean }],
        }],
      },
    });
  }
  appendTurn("candidate", clean);
  api(`/api/interviews/${state.interviewId}/transcript/`, {
    method: "POST",
    body: JSON.stringify({ speaker: "candidate", text: clean }),
  }).catch(() => {});
  sendEvent({
    type: "conversation.item.create",
    item: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: clean }],
    },
  });
  sendEvent({ type: "response.create" });
  return true;
}

function activateFallback(question, reason) {
  if (state.fallback) return;
  state.fallback = true;
  state.realtimeConnected = false;
  setConnection("Text fallback", "fallback");
  $("#fallbackComposer").hidden = false;
  $("#fallbackQuestion").textContent = question || "Tell me about your experience.";
  showCaption("maya", question || "Tell me about your experience.");
  commitTurn("interviewer", question || "Tell me about your experience.");
  toast(reason, true);
  speakLocally(question);
}

function speakLocally(text) {
  if (!text || !state.voiceEnabled || !("speechSynthesis" in window)) return;
  speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  const language = $("#responseLanguage").value;
  if (language === "hindi") utterance.lang = "hi-IN";
  utterance.rate = 1.03;
  utterance.onstart = () => setMayaSpeaking(true);
  utterance.onend = () => setMayaSpeaking(false);
  speechSynthesis.speak(utterance);
}

$("#fallbackSend").addEventListener("click", async () => {
  const answer = $("#fallbackText").value.trim();
  if (answer.length < 8) {
    toast(`Give ${state.interviewerName} a fuller answer first.`, true);
    return;
  }
  const button = $("#fallbackSend");
  button.disabled = true;
  appendTurn("candidate", answer);
  try {
    const payload = await api(`/api/interviews/${state.interviewId}/answer/`, {
      method: "POST",
      body: JSON.stringify({ answer }),
    });
    $("#fallbackText").value = "";
    if (payload.complete) {
      toast("You completed the planned questions. End when you are ready.");
      return;
    }
    state.fallbackQuestion = payload.question;
    $("#fallbackQuestion").textContent = payload.question;
    showCaption("maya", payload.question);
    appendTurn("interviewer", payload.question);
    speakLocally(payload.question);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#textSend").addEventListener("click", sendTextComposer);
$("#textMessage").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    sendTextComposer();
  }
});
function sendTextComposer() {
  const input = $("#textMessage");
  const text = input.value.trim();
  if (!text) return;
  if (state.realtimeConnected) {
    sendRealtimeText(text);
  } else {
    $("#fallbackText").value = text;
    $("#fallbackSend").click();
  }
  input.value = "";
  $("#textComposer").hidden = true;
  $("#textControl").classList.remove("active");
}

$("#transcriptToggle").addEventListener("click", () => $("#transcriptDrawer").classList.toggle("open"));
$("#captionExpand").addEventListener("click", () => $("#transcriptDrawer").classList.add("open"));
$("#transcriptClose").addEventListener("click", () => $("#transcriptDrawer").classList.remove("open"));
$("#textControl").addEventListener("click", () => {
  const composer = $("#textComposer");
  composer.hidden = !composer.hidden;
  $("#textControl").classList.toggle("active", !composer.hidden);
  if (!composer.hidden) $("#textMessage").focus();
});
$("#captionControl").addEventListener("click", () => {
  state.captionsEnabled = !state.captionsEnabled;
  $("#captionControl").classList.toggle("off", !state.captionsEnabled);
  $("#captionRail").hidden = !state.captionsEnabled || !$("#activeCaption").textContent;
});
$("#micControl").addEventListener("click", () => {
  state.micEnabled = !state.micEnabled;
  state.stream?.getAudioTracks().forEach((track) => { track.enabled = state.micEnabled; });
  $("#micControl").classList.toggle("off", !state.micEnabled);
  $("#micControl").querySelector("small").textContent = state.micEnabled ? "Mute" : "Unmute";
  $("#micControl").querySelector("span").innerHTML = `<i data-lucide="${state.micEnabled ? "mic" : "mic-off"}"></i>`;
  refreshIcons();
});
$("#cameraControl").addEventListener("click", () => {
  state.cameraEnabled = !state.cameraEnabled;
  state.stream?.getVideoTracks().forEach((track) => { track.enabled = state.cameraEnabled; });
  $("#cameraControl").classList.toggle("off", !state.cameraEnabled);
  $("#cameraOffMessage").classList.toggle("visible", !state.cameraEnabled);
  $("#cameraControl").querySelector("span").innerHTML = `<i data-lucide="${state.cameraEnabled ? "video" : "video-off"}"></i>`;
  refreshIcons();
  if (state.cameraEnabled) clearIntegrityAlertIfRestored();
  else startIntegrityCountdown("camera_off", "Camera video is paused.");
});
$("#soundToggle").addEventListener("click", () => {
  state.voiceEnabled = !state.voiceEnabled;
  if (state.remoteAudio) state.remoteAudio.muted = !state.voiceEnabled;
  if (!state.voiceEnabled && "speechSynthesis" in window) speechSynthesis.cancel();
  $("#soundToggle").innerHTML = `<i data-lucide="${state.voiceEnabled ? "volume-2" : "volume-x"}"></i>`;
  refreshIcons();
});

function bindIntegrityListeners() {
  if (state.listenersBound) return;
  state.listenersBound = true;

  document.addEventListener("visibilitychange", () => {
    if (interviewView.hidden || state.completing) return;
    if (document.hidden) {
      startIntegrityCountdown("tab_hidden", "The interview tab is no longer visible.");
    } else {
      clearIntegrityAlertIfRestored();
    }
  });

  window.addEventListener("blur", () => {
    if (interviewView.hidden || state.completing) return;
    setTimeout(() => {
      if (!interviewView.hidden && !state.completing && !document.hasFocus() && !document.hidden) {
        startIntegrityCountdown("window_blur", "The interview window lost focus.");
      }
    }, 250);
  });

  window.addEventListener("focus", clearIntegrityAlertIfRestored);

  document.addEventListener("fullscreenchange", () => {
    if (interviewView.hidden || state.completing || !state.fullscreenRequired) return;
    if (!document.fullscreenElement) {
      startIntegrityCountdown("fullscreen_exit", "Fullscreen mode was closed.");
    } else {
      clearIntegrityAlertIfRestored();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (interviewView.hidden || state.completing) return;
    const target = event.target;
    const isTyping = target instanceof HTMLElement && (
      target.matches("input, textarea, select") || target.isContentEditable
    );
    if (isTyping) return;
    const restricted = event.metaKey
      || event.ctrlKey
      || event.altKey
      || ["Tab", "Escape", "PrintScreen"].includes(event.key)
      || /^F(?:[1-9]|1[0-2])$/.test(event.key);
    if (!restricted) return;
    const modifiers = [event.metaKey && "Meta", event.ctrlKey && "Ctrl", event.altKey && "Alt", event.shiftKey && "Shift"].filter(Boolean);
    flashRestrictedShortcut([...modifiers, event.key].join("+").slice(0, 80));
  }, true);

  state.stream?.getVideoTracks().forEach((track) => {
    track.addEventListener("ended", () => startIntegrityCountdown("camera_off", "The camera stream ended."));
    track.addEventListener("mute", () => startIntegrityCountdown("camera_off", "The camera stream was interrupted."));
    track.addEventListener("unmute", clearIntegrityAlertIfRestored);
  });

  if (state.fullscreenRequired && !document.fullscreenElement) {
    startIntegrityCountdown("fullscreen_exit", "Fullscreen mode was closed.");
  }
}

function integrityViolationActive(kind = state.integrityKind) {
  if (kind === "tab_hidden") return document.hidden;
  if (kind === "window_blur") return !document.hidden && !document.hasFocus();
  if (kind === "fullscreen_exit") return state.fullscreenRequired && !document.fullscreenElement;
  if (kind === "camera_off") {
    const track = state.stream?.getVideoTracks()?.[0];
    return !state.cameraEnabled || !track || track.readyState !== "live" || track.muted;
  }
  return false;
}

function showIntegrityShield(title, reason, countdown, canRestore = true) {
  $("#integrityTitle").textContent = title;
  $("#integrityReason").textContent = reason;
  $("#integrityCountdown").textContent = countdown;
  $("#restoreIntegrity").hidden = !canRestore;
  $("#integrityShield").hidden = false;
  document.body.classList.add("integrity-alert");
  refreshIcons();
}

function hideIntegrityShield() {
  $("#integrityShield").hidden = true;
  document.body.classList.remove("integrity-alert");
}

function startIntegrityCountdown(kind, reason) {
  if (interviewView.hidden || state.completing) return;
  if (state.integrityKind && state.integrityKind !== kind && integrityViolationActive()) return;
  clearTimeout(state.integrityWarningTimer);
  clearInterval(state.integrityTimer);
  state.integrityKind = kind;
  state.integrityReason = reason;
  state.integrityDeadline = Date.now() + 5000;
  recordIntegrity(kind, { reason, countdown_seconds: 5 });

  const tick = () => {
    if (!integrityViolationActive(kind)) {
      clearIntegrityAlertIfRestored();
      return;
    }
    const remaining = Math.max(0, Math.ceil((state.integrityDeadline - Date.now()) / 1000));
    showIntegrityShield("Return to the interview", reason, String(remaining));
    if (remaining <= 0) completeInterview("integrity_timeout");
  };
  tick();
  state.integrityTimer = setInterval(tick, 150);
}

function clearIntegrityAlertIfRestored() {
  if (!state.integrityKind || integrityViolationActive()) return;
  clearInterval(state.integrityTimer);
  state.integrityTimer = null;
  state.integrityKind = "";
  state.integrityReason = "";
  state.integrityDeadline = 0;
  hideIntegrityShield();
}

function flashRestrictedShortcut(shortcut) {
  recordIntegrity("restricted_shortcut", { reason: "restricted_shortcut", shortcut });
  if (state.integrityKind) return;
  clearTimeout(state.integrityWarningTimer);
  showIntegrityShield(
    "Restricted shortcut observed",
    "Keep the interview window active. This browser signal is recorded for context only.",
    "!",
    false
  );
  state.integrityWarningTimer = setTimeout(() => {
    if (!state.integrityKind) hideIntegrityShield();
  }, 1800);
}

async function restoreInterviewIntegrity() {
  if (state.integrityKind === "camera_off") {
    state.cameraEnabled = true;
    state.stream?.getVideoTracks().forEach((track) => { track.enabled = true; });
    $("#cameraControl").classList.remove("off");
    $("#cameraOffMessage").classList.remove("visible");
    $("#cameraControl").querySelector("span").innerHTML = '<i data-lucide="video"></i>';
  }
  if (state.fullscreenRequired && !document.fullscreenElement) await requestProtectedFullscreen();
  window.focus();
  refreshIcons();
  setTimeout(clearIntegrityAlertIfRestored, 120);
}

$("#restoreIntegrity").addEventListener("click", restoreInterviewIntegrity);

async function recordIntegrity(kind, details = {}, durationMs = 0) {
  if (!state.interviewId || state.completing) return;
  const last = state.cooldowns.get(`event:${kind}`) || 0;
  if (Date.now() - last < 12000) return;
  state.cooldowns.set(`event:${kind}`, Date.now());
  state.eventCount += 1;
  $("#eventCount").textContent = state.eventCount;
  try {
    await api(`/api/interviews/${state.interviewId}/event/`, {
      method: "POST",
      body: JSON.stringify({
        kind,
        details,
        duration_ms: durationMs,
        occurred_at: new Date().toISOString(),
      }),
    });
  } catch { /* Monitoring must never stop the interview. */ }
}

function showCoaching(message, speak = true, kind = "") {
  const banner = $("#coachingBanner");
  banner.querySelector("span").textContent = message;
  banner.hidden = false;
  state.activeCoachingKind = kind;
  const feedback = $("#coachingFeedback");
  feedback.hidden = !kind;
  clearTimeout(state.coachingTimer);
  state.coachingTimer = setTimeout(() => {
    banner.hidden = true;
    feedback.hidden = true;
    state.activeCoachingKind = "";
  }, 8500);
  if (!speak) return;
  state.pendingVisionCue = { message, queuedAt: Date.now() };
  flushVisionCue();
}

function flushVisionCue() {
  clearTimeout(state.visionCueTimer);
  state.visionCueTimer = null;
  const cue = state.pendingVisionCue;
  if (!cue || !state.realtimeConnected || state.activeVisionCue) return;
  if (Date.now() - cue.queuedAt > 30000) {
    state.pendingVisionCue = null;
    return;
  }
  if (state.candidateSpeaking || state.mayaSpeaking) return;
  const wait = state.visionCueCooldown - Date.now();
  if (wait > 0) {
    state.visionCueTimer = setTimeout(flushVisionCue, Math.min(wait + 100, 30000));
    return;
  }
  state.pendingVisionCue = null;
  state.visionCueCooldown = Date.now() + 90000;
  sendRealtimeText(cue.message, true);
}

function sustainedCondition(kind, bad, seconds, message, details = {}, speak = true) {
  const now = Date.now();
  if (state.dismissedCues.has(kind)) {
    state.conditions.delete(kind);
    return;
  }
  const condition = state.conditions.get(kind);
  if (!bad) {
    if (!condition) return;
    if (!condition.goodSince) condition.goodSince = now;
    if (now - condition.goodSince >= 3500) state.conditions.delete(kind);
    return;
  }
  const active = condition || { startedAt: now, goodSince: 0, reported: false };
  active.goodSince = 0;
  state.conditions.set(kind, active);
  if (active.reported || now - active.startedAt < seconds * 1000) return;
  active.reported = true;
  recordIntegrity(kind, details, now - active.startedAt);
  showCoaching(message, speak, kind);
}

async function loadVisionRuntime() {
  let lastError = null;
  for (const source of MEDIAPIPE_SOURCES) {
    try {
      const vision = await import(source.module);
      const files = await vision.FilesetResolver.forVisionTasks(source.wasm);
      return { vision, files };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Local vision runtime could not be downloaded.");
}

async function initVision() {
  $("#visionStatus").innerHTML = '<i data-lucide="loader-circle"></i> Loading face, eyes, pose & hands';
  refreshIcons();
  try {
    const { vision, files } = await loadVisionRuntime();
    const delegateOptions = async (Ctor, modelAssetPath, extras = {}) => {
      try {
        return await Ctor.createFromOptions(files, {
          baseOptions: { modelAssetPath, delegate: "GPU" },
          runningMode: "VIDEO",
          ...extras,
        });
      } catch {
        return Ctor.createFromOptions(files, {
          baseOptions: { modelAssetPath, delegate: "CPU" },
          runningMode: "VIDEO",
          ...extras,
        });
      }
    };
    const models = [
      {
        key: "faceLandmarker",
        label: "face + eyes",
        ctor: vision.FaceLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
        options: {
          numFaces: 2,
          minFaceDetectionConfidence: .5,
          minFacePresenceConfidence: .5,
          minTrackingConfidence: .5,
          outputFaceBlendshapes: true,
          outputFacialTransformationMatrixes: true,
        },
      },
      {
        key: "poseLandmarker",
        label: "posture",
        ctor: vision.PoseLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task",
        options: {
          numPoses: 1,
          minPoseDetectionConfidence: .52,
          minPosePresenceConfidence: .52,
          minTrackingConfidence: .52,
        },
      },
      {
        key: "handLandmarker",
        label: "hands",
        ctor: vision.HandLandmarker,
        path: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
        options: {
          numHands: 2,
          minHandDetectionConfidence: .45,
          minHandPresenceConfidence: .45,
          minTrackingConfidence: .45,
        },
      },
    ];
    const failed = [];
    for (let index = 0; index < models.length; index += 1) {
      const model = models[index];
      $("#visionStatus").innerHTML = `<i data-lucide="loader-circle"></i> Loading ${model.label}`;
      refreshIcons();
      try {
        state[model.key] = await delegateOptions(model.ctor, model.path, model.options);
        if (!state.visionRunning) {
          state.visionRunning = true;
          state.visionFpsAt = performance.now();
          requestAnimationFrame(visionLoop);
        }
      } catch (error) {
        failed.push(model.label);
        console.warn(`[HireLens vision] ${model.label} failed to initialize.`, error?.message || error);
      }
      const active = models.slice(0, index + 1).filter((item) => state[item.key]).map((item) => item.label);
      const remaining = models.slice(index + 1).map((item) => item.label);
      $("#visionStatus").innerHTML = remaining.length
        ? `<i data-lucide="loader-circle"></i> ${active.length ? `${active.join(" · ")} active · ` : ""}loading ${remaining[0]}`
        : `<i data-lucide="${active.length ? "shield-check" : "circle-alert"}"></i> ${active.length ? `Local ${active.join(" · ")} active` : "Camera active · advanced landmarks unavailable"}`;
      refreshIcons();
    }
    if (failed.length) {
      recordIntegrity("vision_unavailable", { reason: failed.join(",") });
      showCoaching(`Some local tracking is unavailable: ${failed.join(", ")}. Camera clarity checks will continue.`, false);
    }
    if (state.visionRunning) startVisionCalibration();
    if (!state.visionRunning) requestAnimationFrame(clarityOnlyLoop);
  } catch (error) {
    console.warn("[HireLens vision] runtime failed to initialize.", error?.message || error);
    $("#visionStatus").innerHTML = '<i data-lucide="circle-alert"></i> Camera active · advanced landmarks unavailable';
    $("#faceChip").classList.add("warn");
    $("#postureChip").classList.add("warn");
    $("#handsChip").classList.add("warn");
    setHudStatus("eyeStatus", "unavailable", "warn");
    setHudStatus("postureStatus", "unavailable", "warn");
    setHudStatus("handStatus", "unavailable", "warn");
    setHudStatus("trackingFps", "clarity only", "warn");
    recordIntegrity("vision_unavailable", { reason: "runtime_download_failed" });
    showCoaching("Local movement tracking could not start. Check your connection and reload before continuing.", false);
    refreshIcons();
    requestAnimationFrame(clarityOnlyLoop);
  }
}

function setHudStatus(id, text, tone = "") {
  const element = $(`#${id}`);
  if (!element) return;
  element.textContent = text;
  element.className = tone;
}

function observeVision(kind, value, timestamp = performance.now()) {
  const history = state.visionHistory[kind];
  if (!history) return;
  history.push({ at: timestamp, value: Math.max(0, Math.min(Number(value) || 0, 1)) });
  const cutoff = timestamp - VISION_HISTORY_MS;
  while (history.length && history[0].at < cutoff) history.shift();
}

function recentVisionAverage(kind, durationMs = 8000, fallback = 0) {
  const history = state.visionHistory[kind] || [];
  const cutoff = performance.now() - durationMs;
  const recent = history.filter((sample) => sample.at >= cutoff);
  if (!recent.length) return fallback;
  return recent.reduce((sum, sample) => sum + sample.value, 0) / recent.length;
}

function updateVisionConfidence(value) {
  const sample = Math.max(0, Math.min(Number(value) || 0, 1));
  const speed = sample > state.visionConfidence ? .18 : .08;
  state.visionConfidence += (sample - state.visionConfidence) * speed;
}

function visionMetrics() {
  const elapsedSeconds = Math.max(
    1,
    (Date.now() - (state.visionTelemetryStartedAt || Date.now())) / 1000
  );
  return {
    face_presence_ratio: recentVisionAverage("face", 60000),
    shoulder_presence_ratio: recentVisionAverage("shoulders", 60000),
    posture_alignment_ratio: recentVisionAverage("posture", 60000),
    hand_presence_ratio: recentVisionAverage("hands", 60000),
    gaze_stability_ratio: recentVisionAverage("gaze", 60000, 1),
    clarity_ratio: recentVisionAverage("clarity", 60000, 1),
    calibration_confidence: (
      recentVisionAverage("face", 12000)
      + recentVisionAverage("shoulders", 12000)
    ) / 2,
    movement_score: Math.min(1, state.motionEma / .05),
    average_fps: Math.min(120, state.visionFrameTotal / elapsedSeconds),
    tracking_confidence: Math.max(0, Math.min(1, state.visionConfidence)),
    current_face_count: Math.min(2, state.currentFaceCount),
    current_hand_count: Math.min(2, Math.max(state.detectedHandCount, state.poseHandCount)),
    upper_body_visible: state.stableUpperBodyVisible ? 1 : 0,
    current_gaze_aligned: state.currentGazeAligned ? 1 : 0,
  };
}

async function sendVisionTelemetry(action = "window", cueKind = "") {
  if (!state.interviewId || (state.completing && action !== "complete")) return;
  try {
    await api(`/api/interviews/${state.interviewId}/calibration/`, {
      method: "POST",
      body: JSON.stringify({
        action,
        model_version: VISION_MODEL_VERSION,
        sample_count: state.visionFrameTotal,
        metrics: visionMetrics(),
        cue_kind: cueKind,
      }),
    });
  } catch { /* Calibration telemetry must never interrupt the interview. */ }
}

function startVisionCalibration() {
  if (state.calibrationStartedAt) return;
  state.calibrationStartedAt = performance.now();
  state.visionTelemetryStartedAt = Date.now();
  state.calibrationComplete = false;
  $("#visionStatus").innerHTML = '<i data-lucide="scan-line"></i> Learning your camera baseline · 10s';
  setHudStatus("postureStatus", "calibrating", "");
  setHudStatus("handStatus", "calibrating", "");
  setHudStatus("eyeStatus", "calibrating", "");
  refreshIcons();
}

function updateVisionCalibration(timestamp) {
  if (!state.calibrationStartedAt || state.calibrationComplete) return;
  const elapsed = timestamp - state.calibrationStartedAt;
  const secondsLeft = Math.max(0, Math.ceil((VISION_CALIBRATION_MS - elapsed) / 1000));
  if (elapsed < VISION_CALIBRATION_MS) {
    $("#visionStatus").innerHTML = `<i data-lucide="scan-line"></i> Learning your camera baseline · ${secondsLeft}s`;
    return;
  }
  state.calibrationComplete = true;
  state.calibrationBaseline = visionMetrics();
  state.conditions.clear();
  $("#visionStatus").innerHTML = '<i data-lucide="shield-check"></i> Adaptive local tracking active';
  toast("Camera baseline learned. Coaching is now calibrated to this session.");
  sendVisionTelemetry("calibrated");
  syncVisionContext(true);
  clearInterval(state.visionTelemetryTimer);
  state.visionTelemetryTimer = setInterval(
    () => sendVisionTelemetry("window"),
    20000
  );
  refreshIcons();
}

function prepareLandmarkCanvas() {
  const canvas = $("#landmarkCanvas");
  const width = candidateVideo.videoWidth || candidateVideo.clientWidth;
  const height = candidateVideo.videoHeight || candidateVideo.clientHeight;
  if (!width || !height) return null;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, width, height);
  return { canvas, context, width, height };
}

function visionLoop(timestamp) {
  if (!state.visionRunning || interviewView.hidden || !state.cameraEnabled) {
    if (state.visionRunning && !state.completing) requestAnimationFrame(visionLoop);
    return;
  }
  const drawing = prepareLandmarkCanvas();
  if (!drawing || candidateVideo.readyState < 2) {
    requestAnimationFrame(visionLoop);
    return;
  }
  updateVisionCalibration(timestamp);
  const dueTasks = [
    {
      landmarker: state.faceLandmarker,
      interval: 90,
      lastRun: state.lastFaceRun,
      run: () => {
        state.lastFaceRun = timestamp;
        state.lastFaceResult = state.faceLandmarker.detectForVideo(candidateVideo, timestamp);
        handleFace(state.lastFaceResult);
      },
    },
    {
      landmarker: state.poseLandmarker,
      interval: 125,
      lastRun: state.lastPoseRun,
      run: () => {
        state.lastPoseRun = timestamp;
        state.lastPoseResult = state.poseLandmarker.detectForVideo(candidateVideo, timestamp);
        handlePose(state.lastPoseResult);
      },
    },
    {
      landmarker: state.handLandmarker,
      interval: 105,
      lastRun: state.lastHandRun,
      run: () => {
        state.lastHandRun = timestamp;
        state.lastHandResult = state.handLandmarker.detectForVideo(candidateVideo, timestamp);
        handleHands(state.lastHandResult);
      },
    },
  ]
    .filter((task) => task.landmarker && timestamp - task.lastRun >= task.interval)
    .sort((a, b) => (timestamp - b.lastRun) / b.interval - (timestamp - a.lastRun) / a.interval);
  let inferenceRuns = 0;
  if (dueTasks.length) {
    const frameBudget = state.inferenceCostEma < 18 ? 2 : 1;
    dueTasks.slice(0, frameBudget).forEach((task) => {
      try {
        const started = performance.now();
        task.run();
        const cost = performance.now() - started;
        state.inferenceCostEma = state.inferenceCostEma
          ? state.inferenceCostEma * .82 + cost * .18
          : cost;
        inferenceRuns += 1;
      } catch { /* Try the next scheduled frame. */ }
    });
  }
  if (timestamp - state.lastClarityRun > 1500) {
    state.lastClarityRun = timestamp;
    analyzeClarity();
  }
  drawTrackingOverlay(drawing);
  if (inferenceRuns) {
    state.visionFrames += inferenceRuns;
    state.visionFrameTotal += inferenceRuns;
  }
  if (timestamp - state.visionFpsAt >= 1000) {
    const fps = Math.round(state.visionFrames * 1000 / (timestamp - state.visionFpsAt));
    const confidence = Math.round(state.visionConfidence * 100);
    setHudStatus("trackingFps", `${fps}Hz · ${confidence}%`, confidence >= 62 ? "ok" : "warn");
    state.visionFrames = 0;
    state.visionFpsAt = timestamp;
  }
  requestAnimationFrame(visionLoop);
}

function clarityOnlyLoop(timestamp) {
  if (interviewView.hidden || state.completing) return;
  if (state.cameraEnabled && timestamp - state.lastClarityRun > 1800) {
    state.lastClarityRun = timestamp;
    analyzeClarity();
  }
  requestAnimationFrame(clarityOnlyLoop);
}

function dot(context, point, width, height, color = "rgba(99,239,178,.7)", radius = 2) {
  context.beginPath();
  context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
  context.fillStyle = color;
  context.fill();
}

function line(context, a, b, width, height, color, size = 1.4) {
  if (!a || !b) return;
  context.beginPath();
  context.moveTo(a.x * width, a.y * height);
  context.lineTo(b.x * width, b.y * height);
  context.strokeStyle = color;
  context.lineWidth = size;
  context.stroke();
}

function drawTrackingOverlay(drawing) {
  const { context, width, height } = drawing;
  const face = state.lastFaceResult?.faceLandmarks?.[0];
  if (face) {
    const eyeLoops = [
      [33, 160, 158, 133, 153, 144, 33],
      [362, 385, 387, 263, 373, 380, 362],
    ];
    eyeLoops.forEach((loop) => {
      for (let index = 1; index < loop.length; index += 1) {
        line(context, face[loop[index - 1]], face[loop[index]], width, height, "rgba(99,239,178,.8)", 1.6);
      }
    });
    [468, 469, 470, 471, 472, 473, 474, 475, 476, 477, 1, 10, 152].forEach((index) => {
      if (face[index]) dot(context, face[index], width, height, "rgba(173,255,212,.9)", index >= 468 ? 1.8 : 2.2);
    });
  }
  const pose = state.lastPoseResult?.landmarks?.[0];
  if (pose) {
    const poseConnections = [
      [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
      [11, 23], [12, 24], [23, 24],
    ];
    poseConnections.forEach(([a, b]) => line(context, pose[a], pose[b], width, height, "rgba(213,248,113,.72)", 2.1));
    [0, 11, 12, 13, 14, 15, 16, 23, 24].forEach((index) => {
      if (pose[index]) dot(context, pose[index], width, height, "rgba(213,248,113,.9)", 3);
    });
  }
  const handConnections = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [5, 9], [9, 10], [10, 11], [11, 12],
    [9, 13], [13, 14], [14, 15], [15, 16],
    [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
  ];
  (state.lastHandResult?.landmarks || []).forEach((hand) => {
    handConnections.forEach(([a, b]) => line(context, hand[a], hand[b], width, height, "rgba(109,205,255,.8)", 1.7));
    hand.forEach((point) => dot(context, point, width, height, "rgba(145,220,255,.95)", 2));
  });
}

function blendshapeScore(result, name) {
  const category = result.faceBlendshapes?.[0]?.categories?.find((item) => item.categoryName === name);
  return category?.score || 0;
}

function handleFace(result) {
  const faces = result.faceLandmarks || [];
  state.currentFaceCount = Math.min(faces.length, 2);
  const faceOk = faces.length === 1;
  observeVision("face", faceOk ? 1 : 0);
  const recentFacePresence = recentVisionAverage("face", 8000);
  const baselineFacePresence = state.calibrationBaseline.face_presence_ratio || 0;
  $("#faceChip").classList.toggle("ok", faceOk);
  $("#faceChip").classList.toggle("warn", !faceOk);
  sustainedCondition(
    faces.length ? "multiple_faces" : "face_missing",
    state.calibrationComplete && (
      faces.length > 1
      || (faces.length === 0 && baselineFacePresence >= .55 && recentFacePresence < .3)
    ),
    faces.length > 1 ? 4 : 6,
    faces.length > 1 ? "Please keep only one person in the camera frame." : "I can’t see you clearly—please move back into the frame.",
    { face_count: faces.length, confidence: Number(recentFacePresence.toFixed(2)) }
  );
  if (!faces.length) {
    state.currentGazeAligned = false;
    updateVisionConfidence(0);
    setHudStatus("eyeStatus", "not visible", "warn");
    return;
  }
  const points = faces[0];
  const nose = points[1];
  const faceLeft = points[33];
  const faceRight = points[263];
  const chin = points[152];
  const eyeLineY = ((points[33]?.y || 0) + (points[263]?.y || 0)) / 2;
  const irisCenter = (indexes) => {
    const found = indexes.map((index) => points[index]).filter(Boolean);
    if (!found.length) return null;
    return found.reduce((sum, point) => ({ x: sum.x + point.x, y: sum.y + point.y }), { x: 0, y: 0 });
  };
  const leftIrisSum = irisCenter([468, 469, 470, 471, 472]);
  const rightIrisSum = irisCenter([473, 474, 475, 476, 477]);
  const normalizeIris = (sum, count, cornerA, cornerB) => {
    if (!sum || !cornerA || !cornerB) return .5;
    const centerX = sum.x / count;
    const min = Math.min(cornerA.x, cornerB.x);
    const max = Math.max(cornerA.x, cornerB.x);
    return (centerX - min) / Math.max(max - min, .001);
  };
  const leftGaze = normalizeIris(leftIrisSum, 5, points[33], points[133]);
  const rightGaze = normalizeIris(rightIrisSum, 5, points[362], points[263]);
  const blink = Math.max(blendshapeScore(result, "eyeBlinkLeft"), blendshapeScore(result, "eyeBlinkRight")) > .58;
  const faceCenter = faceLeft && faceRight ? (faceLeft.x + faceRight.x) / 2 : .5;
  const faceWidth = faceLeft && faceRight ? Math.abs(faceRight.x - faceLeft.x) : .1;
  const yawRatio = nose ? (nose.x - faceCenter) / Math.max(faceWidth, .01) : 0;
  const pitchRatio = nose && chin ? (nose.y - eyeLineY) / Math.max(chin.y - eyeLineY, .01) : .45;
  state.headYawEma = state.headYawEma * .72 + yawRatio * .28;
  state.headPitchEma = state.headPitchEma * .72 + pitchRatio * .28;
  const lookingSideNow = leftGaze < .14 || leftGaze > .86 || rightGaze < .14 || rightGaze > .86;
  state.gazeSideEma = state.gazeSideEma * .7 + (lookingSideNow ? 1 : 0) * .3;
  const lookingSide = state.gazeSideEma > .64;
  const headTurned = Math.abs(state.headYawEma) > .28 || state.headPitchEma < .25 || state.headPitchEma > .72;
  const attentionOff = !blink && (lookingSide || headTurned);
  state.currentGazeAligned = !attentionOff;
  updateVisionConfidence(faceOk ? Math.min(.98, .72 + Math.min(faceWidth, .3) * .75) : .3);
  observeVision("gaze", attentionOff ? 0 : 1);
  const recentGazeStability = recentVisionAverage("gaze", 10000, 1);
  let eyeLabel = "camera aligned";
  if (blink) eyeLabel = "blink";
  else if (state.headYawEma > .28) eyeLabel = "turned left";
  else if (state.headYawEma < -.28) eyeLabel = "turned right";
  else if (state.headPitchEma < .25) eyeLabel = "looking up";
  else if (state.headPitchEma > .72) eyeLabel = "looking down";
  else if (lookingSide) eyeLabel = "looking aside";
  setHudStatus("eyeStatus", eyeLabel, attentionOff ? "warn" : "ok");
  sustainedCondition(
    "gaze_away",
    state.calibrationComplete && attentionOff && recentGazeStability < .35,
    8,
    "Please bring your face and eyes back toward the camera so I can see you clearly.",
    {
      reason: headTurned ? "head_orientation" : "eye_direction",
      confidence: Number((1 - recentGazeStability).toFixed(2)),
    },
    true
  );
}

function updateUpperBodyStability(visible) {
  if (visible) {
    state.upperBodyVisibleFrames = Math.min(12, state.upperBodyVisibleFrames + 1);
    state.upperBodyMissingFrames = 0;
    if (state.upperBodyVisibleFrames >= 3) state.stableUpperBodyVisible = true;
  } else {
    state.upperBodyMissingFrames = Math.min(16, state.upperBodyMissingFrames + 1);
    state.upperBodyVisibleFrames = 0;
    if (state.upperBodyMissingFrames >= 8) state.stableUpperBodyVisible = false;
  }
  return state.stableUpperBodyVisible;
}

function handlePose(result) {
  const poses = result.landmarks || [];
  if (!poses.length) {
    updateVisionConfidence(.12);
    state.poseHandCount = 0;
    observeVision("posture", 0);
    observeVision("shoulders", 0);
    const recentShoulderPresence = recentVisionAverage("shoulders", 10000);
    const baselineShoulderPresence = state.calibrationBaseline.shoulder_presence_ratio || 0;
    const bodyOk = updateUpperBodyStability(false);
    $("#postureChip").classList.toggle("ok", bodyOk);
    $("#postureChip").classList.toggle("warn", !bodyOk);
    $("#bodyFrame").classList.toggle("ok", bodyOk);
    setHudStatus("postureStatus", bodyOk ? "tracking…" : "show shoulders", bodyOk ? "ok" : "warn");
    sustainedCondition(
      "body_not_framed",
      state.calibrationComplete
        && baselineShoulderPresence >= .5
        && recentShoulderPresence < .25,
      12,
      "I’m having trouble seeing both shoulders. Please move back slightly and keep your upper body centered.",
      {
        reason: "shoulders_not_detected",
        confidence: Number((1 - recentShoulderPresence).toFixed(2)),
      }
    );
    return;
  }
  const pose = poses[0];
  const needed = [0, 11, 12, 13, 14, 15, 16, 23, 24];
  const poseConfidence = needed.reduce(
    (sum, index) => sum + Math.max(0, Math.min(pose[index]?.visibility ?? 0, 1)),
    0
  ) / needed.length;
  updateVisionConfidence(poseConfidence);
  const visible = (index, confidence = .3, margin = .01) => {
    const point = pose[index];
    return point
      && (point.visibility ?? 1) >= confidence
      && point.x > margin
      && point.x < 1 - margin
      && point.y > margin
      && point.y < 1 - margin;
  };
  const shoulders = visible(11) && visible(12);
  const shoulderSpan = shoulders ? Math.abs(pose[12].x - pose[11].x) : 0;
  const shoulderY = shoulders ? (pose[11].y + pose[12].y) / 2 : 1;
  const shouldersFramed = shoulders && shoulderSpan > .03 && shoulderY > .06 && shoulderY < .94;
  observeVision("shoulders", shouldersFramed ? 1 : 0);
  const recentShoulderPresence = recentVisionAverage("shoulders", 10000);
  const baselineShoulderPresence = state.calibrationBaseline.shoulder_presence_ratio || 0;
  const bodyOk = updateUpperBodyStability(shouldersFramed);
  state.poseHandCount = Number(visible(15, .24)) + Number(visible(16, .24));
  state.poseHandsVisible = state.poseHandCount === 2;
  const shoulderTilt = shoulders ? Math.abs(Math.atan2(pose[12].y - pose[11].y, pose[12].x - pose[11].x) * 180 / Math.PI) : 90;
  const centerX = shoulders ? (pose[11].x + pose[12].x) / 2 : .5;
  state.shoulderTiltEma = state.shoulderTiltEma * .8 + shoulderTilt * .2;
  state.bodyCenterEma = state.bodyCenterEma * .78 + centerX * .22;
  const centered = state.bodyCenterEma > .16 && state.bodyCenterEma < .84;
  const postureOk = bodyOk && centered;
  observeVision("posture", postureOk ? 1 : 0);
  $("#bodyFrame").classList.toggle("ok", bodyOk);
  $("#postureChip").classList.toggle("ok", postureOk);
  $("#postureChip").classList.toggle("warn", !postureOk);
  setHudStatus(
    "postureStatus",
    !bodyOk ? "show shoulders" : !centered ? "move to center" : "upper body visible",
    postureOk ? "ok" : "warn"
  );
  sustainedCondition(
    "body_not_framed",
    state.calibrationComplete
      && !shouldersFramed
      && baselineShoulderPresence >= .5
      && recentShoulderPresence < .25,
    12,
    "I’m having trouble seeing both shoulders. Please move back slightly and keep your upper body centered.",
    {
      reason: "shoulders_not_detected",
      confidence: Number((1 - recentShoulderPresence).toFixed(2)),
    }
  );

  const current = needed.map((index) => pose[index]).filter(Boolean);
  if (state.lastPosePoints?.length === current.length) {
    const movement = current.reduce((sum, point, index) => {
      const before = state.lastPosePoints[index];
      return sum + Math.hypot(point.x - before.x, point.y - before.y);
    }, 0) / current.length;
    state.motionEma = state.motionEma * .78 + movement * .22;
    const movementLabel = state.motionEma > .035 ? "high" : state.motionEma > .009 ? "natural" : "steady";
    $("#motionValue").textContent = movementLabel;
    sustainedCondition(
      "excessive_motion",
      state.calibrationComplete
        && state.motionEma > Math.max(
          .065,
          (state.calibrationBaseline.movement_score || 0) * .05 * 2.2
        ),
      8,
      "There is a lot of movement in the frame—please steady the camera and settle comfortably.",
      {
        reason: "landmark_motion",
        confidence: Number(Math.min(1, state.motionEma / .08).toFixed(2)),
      }
    );
  }
  state.lastPosePoints = current.map((point) => ({ x: point.x, y: point.y }));
  if (!state.handLandmarker) {
    const handsOk = bodyOk && state.poseHandsVisible;
    observeVision("hands", handsOk ? 1 : 0);
    const recentHandPresence = recentVisionAverage("hands", 12000);
    $("#handsChip").classList.toggle("ok", handsOk);
    $("#handsChip").classList.toggle("warn", !handsOk);
    setHudStatus("handStatus", handsOk ? "wrists visible" : "outside frame", handsOk ? "ok" : "warn");
    sustainedCondition(
      "hands_not_visible",
      state.calibrationComplete
        && bodyOk
        && recentHandPresence < .15,
      20,
      "Your hands have moved outside the frame. Please bring them back when convenient.",
      {
        reason: "hands_left_frame",
        confidence: Number((1 - recentHandPresence).toFixed(2)),
      }
    );
  }
}

function handleHands(result) {
  const hands = result.landmarks || [];
  const detectedCount = Math.min(hands.length, 2);
  state.detectedHandCount = detectedCount;
  const fusedCount = Math.max(detectedCount, state.poseHandCount || 0);
  const handednessConfidence = (result.handednesses || [])
    .flatMap((items) => items || [])
    .reduce((highest, item) => Math.max(highest, Number(item.score) || 0), 0);
  updateVisionConfidence(detectedCount ? Math.max(.55, handednessConfidence) : fusedCount ? .5 : .08);
  observeVision("hands", fusedCount / 2);
  state.handPresenceEma = state.handPresenceEma * .64 + (fusedCount / 2) * .36;
  if (fusedCount === state.pendingHandCount) state.handVisibleFrames += 1;
  else {
    state.pendingHandCount = fusedCount;
    state.handVisibleFrames = 1;
  }
  if (fusedCount < state.stableHandCount) state.handMissingFrames += 1;
  else state.handMissingFrames = 0;
  if (fusedCount > state.stableHandCount && state.handVisibleFrames >= 2) {
    state.stableHandCount = fusedCount;
  } else if (fusedCount < state.stableHandCount && state.handMissingFrames >= 5) {
    state.stableHandCount = fusedCount;
    state.handMissingFrames = 0;
  }
  const recentHandPresence = recentVisionAverage("hands", 12000);
  const stableCount = state.stableHandCount;
  const handsOk = stableCount === 2;
  $("#handsChip").classList.toggle("ok", handsOk);
  $("#handsChip").classList.toggle("warn", !handsOk);
  const source = detectedCount >= stableCount ? "visible" : "tracked";
  setHudStatus("handStatus", `${stableCount}/2 ${source}`, handsOk ? "ok" : "warn");
  sustainedCondition(
    "hands_not_visible",
    state.calibrationComplete
      && state.stableUpperBodyVisible
      && recentHandPresence < .15,
    20,
    "Your hands have moved outside the frame. Please bring them back when convenient.",
    {
      reason: "hands_left_frame",
      confidence: Number((1 - recentHandPresence).toFixed(2)),
    }
  );
}

function analyzeClarity() {
  if (candidateVideo.readyState < 2) return;
  const canvas = document.createElement("canvas");
  canvas.width = 80;
  canvas.height = 60;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  context.drawImage(candidateVideo, 0, 0, canvas.width, canvas.height);
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const gray = new Float32Array(canvas.width * canvas.height);
  let light = 0;
  for (let i = 0, p = 0; i < pixels.length; i += 4, p += 1) {
    gray[p] = pixels[i] * .299 + pixels[i + 1] * .587 + pixels[i + 2] * .114;
    light += gray[p];
  }
  light /= gray.length;
  let lapSum = 0;
  let lapSq = 0;
  let count = 0;
  for (let y = 1; y < canvas.height - 1; y += 1) {
    for (let x = 1; x < canvas.width - 1; x += 1) {
      const i = y * canvas.width + x;
      const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - canvas.width] - gray[i + canvas.width];
      lapSum += lap;
      lapSq += lap * lap;
      count += 1;
    }
  }
  const variance = lapSq / count - (lapSum / count) ** 2;
  const lowLight = light < 42;
  const blurry = !lowLight && variance < 85;
  const clear = !lowLight && !blurry;
  observeVision("clarity", clear ? 1 : 0);
  $("#clarityChip").classList.toggle("ok", clear);
  $("#clarityChip").classList.toggle("warn", !clear);
  sustainedCondition(
    "low_light",
    state.calibrationComplete && lowLight && recentVisionAverage("clarity", 10000, 1) < .25,
    8,
    "The room looks dark—please add a little light in front of you."
  );
  sustainedCondition(
    "camera_blurry",
    state.calibrationComplete && blurry && recentVisionAverage("clarity", 12000, 1) < .2,
    10,
    "Your camera looks blurry. Please clean the lens or move into better focus."
  );
}

async function initAvatar() {
  try {
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.179.1/build/three.module.js");
    const canvas = $("#avatarCanvas");
    const scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0xc8bdaf, .012);
    const camera = new THREE.PerspectiveCamera(33, 1, .1, 100);
    camera.position.set(0, .05, 10.25);
    const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.7));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.18;

    const avatar = new THREE.Group();
    avatar.position.y = .05;
    avatar.scale.set(.96, .96, .96);
    scene.add(avatar);
    const headGroup = new THREE.Group();
    avatar.add(headGroup);
    const armsGroup = new THREE.Group();
    avatar.add(armsGroup);
    const isMale = state.interviewerStyle === "male";

    const skin = new THREE.MeshPhysicalMaterial({
      color: isMale ? 0xe8ad82 : 0xf0bb92,
      roughness: .67,
      clearcoat: .035,
      clearcoatRoughness: .9,
    });
    const skinWarm = new THREE.MeshStandardMaterial({ color: isMale ? 0xce805d : 0xd98f68, roughness: .74 });
    const hairMaterial = new THREE.MeshStandardMaterial({ color: isMale ? 0x352720 : 0x4b3028, roughness: .82 });
    const hairSoft = new THREE.MeshStandardMaterial({ color: isMale ? 0x4b372c : 0x604238, roughness: .76 });
    const featureMaterial = new THREE.MeshStandardMaterial({ color: 0x4a2828, roughness: .9 });
    const blazer = new THREE.MeshPhysicalMaterial({ color: isMale ? 0x303432 : 0x29493d, roughness: .76, clearcoat: .035 });
    const blazerDark = new THREE.MeshStandardMaterial({ color: isMale ? 0x1d211f : 0x152b23, roughness: .86 });
    const blouse = new THREE.MeshStandardMaterial({ color: 0xf1eee7, roughness: .88 });
    const sclera = new THREE.MeshStandardMaterial({ color: 0xfffbf5, roughness: .72 });
    const irisMaterial = new THREE.MeshPhysicalMaterial({ color: 0x55302e, roughness: .54, clearcoat: .15 });
    const pupilMaterial = new THREE.MeshStandardMaterial({ color: 0x241817, roughness: .82 });
    const lipMaterial = new THREE.MeshStandardMaterial({ color: 0x6d3439, roughness: .82 });
    const mouthInnerMaterial = new THREE.MeshStandardMaterial({ color: 0x3b2024, roughness: 1 });
    const shoeWhite = new THREE.MeshStandardMaterial({ color: 0xf7f4ee, roughness: .82 });
    const accent = new THREE.MeshStandardMaterial({ color: isMale ? 0x4a886f : 0xb99367, roughness: .7 });

    const makeMesh = (geometry, material, position, scale, parent = avatar) => {
      const mesh = new THREE.Mesh(geometry, material);
      mesh.position.set(...position);
      mesh.scale.set(...scale);
      parent.add(mesh);
      return mesh;
    };
    const capsuleBetween = (start, end, radius, material, z, parent = avatar) => {
      const dx = end[0] - start[0];
      const dy = end[1] - start[1];
      const distance = Math.hypot(dx, dy);
      const mesh = makeMesh(
        new THREE.CapsuleGeometry(radius, Math.max(.05, distance - radius * 2), 8, 24),
        material,
        [(start[0] + end[0]) / 2, (start[1] + end[1]) / 2, z],
        [1, 1, .88],
        parent
      );
      mesh.rotation.z = Math.atan2(-dx, dy);
      return mesh;
    };

    const neck = makeMesh(new THREE.CylinderGeometry(.24, .28, .48, 32), skin, [0, .32, -.02], [1, 1, .9]);
    const torso = makeMesh(new THREE.CapsuleGeometry(.76, 1.08, 10, 36), blazer, [0, -.68, -.08], [1.18, 1, .58]);
    const waist = makeMesh(new THREE.CapsuleGeometry(.65, .34, 8, 30), blazerDark, [0, -1.58, -.08], [1.12, 1, .52]);
    const blousePanel = makeMesh(new THREE.ConeGeometry(.44, 1.18, 3), blouse, [0, -.58, .58], [1, 1, .28]);
    blousePanel.rotation.z = Math.PI;
    const lapelLeft = makeMesh(new THREE.ConeGeometry(.29, .92, 3), blazerDark, [-.29, -.58, .57], [.75, 1, .22]);
    lapelLeft.rotation.z = Math.PI + .2;
    const lapelRight = makeMesh(new THREE.ConeGeometry(.29, .92, 3), blazerDark, [.29, -.58, .57], [.75, 1, .22]);
    lapelRight.rotation.z = Math.PI - .2;

    const legLeft = makeMesh(new THREE.CapsuleGeometry(.26, 1.32, 8, 24), blazerDark, [-.34, -2.32, -.06], [1, 1, .85]);
    const legRight = makeMesh(new THREE.CapsuleGeometry(.26, 1.32, 8, 24), blazerDark, [.34, -2.32, -.06], [1, 1, .85]);
    const shoeLeft = makeMesh(new THREE.CapsuleGeometry(.23, .48, 8, 24), shoeWhite, [-.34, -3.18, .16], [1.1, 1, 1.18]);
    const shoeRight = makeMesh(new THREE.CapsuleGeometry(.23, .48, 8, 24), shoeWhite, [.34, -3.18, .16], [1.1, 1, 1.18]);
    shoeLeft.rotation.x = shoeRight.rotation.x = Math.PI / 2.75;
    makeMesh(new THREE.BoxGeometry(.5, .07, .42), accent, [-.34, -3.08, .36], [1, 1, 1]);
    makeMesh(new THREE.BoxGeometry(.5, .07, .42), accent, [.34, -3.08, .36], [1, 1, 1]);

    const leftShoulder = [-.72, -.42];
    const rightShoulder = [.72, -.42];
    const leftElbow = [-.7, -.78];
    const rightElbow = [.7, -.82];
    const leftHand = [.43, -.72];
    const rightHand = [-.43, -.55];
    capsuleBetween(leftShoulder, leftElbow, .235, blazer, .28, armsGroup);
    capsuleBetween(rightShoulder, rightElbow, .235, blazer, .3, armsGroup);
    const leftArm = capsuleBetween(leftElbow, leftHand, .155, skin, .73, armsGroup);
    const rightArm = capsuleBetween(rightElbow, rightHand, .155, skin, .82, armsGroup);
    makeMesh(new THREE.SphereGeometry(.175, 24, 18), skin, [leftHand[0], leftHand[1], .74], [1.08, .78, .72], armsGroup);
    makeMesh(new THREE.SphereGeometry(.175, 24, 18), skin, [rightHand[0], rightHand[1], .83], [1.08, .78, .72], armsGroup);

    const head = makeMesh(new THREE.SphereGeometry(1, 56, 44), skin, [0, 1.31, 0], [isMale ? .8 : .77, isMale ? .89 : .92, .72], headGroup);
    makeMesh(new THREE.SphereGeometry(.18, 28, 20), skin, [-.79, 1.3, -.02], [.52, .82, .42], headGroup);
    makeMesh(new THREE.SphereGeometry(.18, 28, 20), skin, [.79, 1.3, -.02], [.52, .82, .42], headGroup);
    makeMesh(new THREE.SphereGeometry(.07, 18, 14), skinWarm, [-.82, 1.29, .03], [.4, .7, .25], headGroup);
    makeMesh(new THREE.SphereGeometry(.07, 18, 14), skinWarm, [.82, 1.29, .03], [.4, .7, .25], headGroup);

    const hairCap = makeMesh(
      new THREE.SphereGeometry(1.02, 48, 32, 0, Math.PI * 2, 0, Math.PI * .62),
      hairMaterial,
      [0, 1.69, -.07],
      [.82, .75, .75],
      headGroup
    );
    hairCap.rotation.z = -.02;
    const sweptFringe = makeMesh(
      new THREE.SphereGeometry(.65, 42, 28),
      hairSoft,
      [-.13, isMale ? 1.91 : 1.88, .28],
      [1.05, isMale ? .34 : .4, .68],
      headGroup
    );
    sweptFringe.rotation.z = isMale ? -.1 : -.15;
    const sideHair = makeMesh(
      new THREE.CapsuleGeometry(.12, isMale ? .38 : .72, 8, 20),
      hairMaterial,
      [.69, isMale ? 1.48 : 1.38, -.05],
      [1, 1, .8],
      headGroup
    );
    sideHair.rotation.z = -.06;
    if (!isMale) {
      const leftBob = makeMesh(new THREE.CapsuleGeometry(.105, .58, 8, 20), hairMaterial, [-.69, 1.36, -.08], [1, 1, .78], headGroup);
      leftBob.rotation.z = .05;
    }

    const eyeGroups = [];
    const irises = [];
    [-.29, .29].forEach((x) => {
      const eyeGroup = new THREE.Group();
      eyeGroup.position.set(x, 1.38, .67);
      headGroup.add(eyeGroup);
      makeMesh(new THREE.SphereGeometry(.135, 28, 20), sclera, [0, 0, 0], [1.02, .83, .42], eyeGroup);
      const iris = makeMesh(new THREE.SphereGeometry(.078, 24, 18), irisMaterial, [0, -.006, .104], [1, 1, .34], eyeGroup);
      makeMesh(new THREE.SphereGeometry(.04, 20, 14), pupilMaterial, [0, -.006, .13], [1, 1, .3], eyeGroup);
      makeMesh(new THREE.SphereGeometry(.014, 12, 10), sclera, [-.021, .022, .15], [1, 1, .25], eyeGroup);
      eyeGroups.push(eyeGroup);
      irises.push(iris);
      const brow = makeMesh(new THREE.CapsuleGeometry(.022, .19, 5, 14), featureMaterial, [x, 1.61, .69], [1, 1, .5], headGroup);
      brow.rotation.z = x < 0 ? -1.62 : 1.62;
    });

    makeMesh(new THREE.SphereGeometry(.075, 24, 18), skinWarm, [0, 1.19, .7], [.62, .52, .5], headGroup);
    const mouthInner = makeMesh(new THREE.SphereGeometry(.12, 28, 20), mouthInnerMaterial, [0, .98, .68], [1.22, .15, .28], headGroup);
    const teeth = makeMesh(new THREE.BoxGeometry(.18, .035, .025), sclera, [0, .992, .75], [1, 1, 1], headGroup);
    const upperLip = makeMesh(new THREE.SphereGeometry(.085, 24, 16), lipMaterial, [0, 1.005, .75], [1.45, .17, .22], headGroup);
    const lowerLip = makeMesh(new THREE.SphereGeometry(.085, 24, 16), lipMaterial, [0, .965, .75], [1.45, .19, .22], headGroup);
    const chin = makeMesh(new THREE.SphereGeometry(.11, 24, 18), skin, [0, .81, .59], [.82, .5, .38], headGroup);

    const halo = makeMesh(
      new THREE.TorusGeometry(2.45, .011, 8, 100),
      new THREE.MeshBasicMaterial({ color: 0x315f50, transparent: true, opacity: .24 }),
      [0, -.25, -1.35],
      [1, 1, 1],
      scene
    );
    makeMesh(
      new THREE.CircleGeometry(1.15, 48),
      new THREE.MeshBasicMaterial({ color: 0x6b665e, transparent: true, opacity: .15, depthWrite: false }),
      [0, -3.43, -.25],
      [1.45, .72, 1],
      scene
    ).rotation.x = -Math.PI / 2;

    scene.add(new THREE.HemisphereLight(0xfff7ec, 0x3c4540, 2.7));
    const key = new THREE.DirectionalLight(0xffe2c9, 3.15);
    key.position.set(-3.5, 4.5, 5.5);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xd7eeff, 1.45);
    fill.position.set(3.2, 2.5, 4);
    scene.add(fill);
    const faceLight = new THREE.PointLight(0xffead8, 6.2, 10);
    faceLight.position.set(0, 1.45, 4.4);
    scene.add(faceLight);
    const rim = new THREE.PointLight(0x9de6ca, 12, 12);
    rim.position.set(2.8, 2.2, 1.4);
    scene.add(rim);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      renderer.setSize(rect.width, rect.height, false);
      camera.aspect = rect.width / Math.max(rect.height, 1);
      camera.updateProjectionMatrix();
    };
    resize();
    window.addEventListener("resize", resize);
    $("#avatarFallback").hidden = true;

    let nextBlink = 1800 + Math.random() * 1800;
    let blinkStarted = -1;
    const animate = (time) => {
      if (state.completing) return;
      if (time > nextBlink && blinkStarted < 0) {
        blinkStarted = time;
        nextBlink = time + 2600 + Math.random() * 3200;
      }
      let blinkAmount = 0;
      if (blinkStarted >= 0) {
        const phase = (time - blinkStarted) / 170;
        blinkAmount = phase < .5 ? phase * 2 : Math.max(0, 2 - phase * 2);
        if (phase >= 1) blinkStarted = -1;
      }
      eyeGroups.forEach((eye, index) => {
        eye.scale.y = Math.max(.09, 1 - blinkAmount * .91);
        eye.rotation.y = Math.sin(time * .00055 + index * .35) * .025;
      });
      irises.forEach((iris, index) => {
        iris.position.x = Math.sin(time * .00042 + index * .16) * .008;
      });
      const voice = sampleMayaVoice();
      const mouthOpen = Math.min(1, voice.energy * 1.22);
      const mouthWidth = 1 + voice.brightness * .22 - mouthOpen * .08;
      mouthInner.scale.set(1.22 * mouthWidth, .15 + mouthOpen * .82, .28);
      mouthInner.position.y = .98 - mouthOpen * .016;
      upperLip.scale.x = 1.45 * mouthWidth;
      lowerLip.scale.x = 1.45 * mouthWidth;
      lowerLip.position.y = .965 - mouthOpen * .043;
      upperLip.position.y = 1.005 + mouthOpen * .015;
      teeth.visible = mouthOpen > .22;
      teeth.scale.y = .62 + mouthOpen * .22;
      teeth.position.y = .992 + mouthOpen * .004;
      chin.position.y = .81 - mouthOpen * .014;
      headGroup.rotation.y = Math.sin(time * .00038) * .035;
      headGroup.rotation.x = state.mayaSpeaking
        ? Math.sin(time * .0028) * .025
        : state.candidateSpeaking ? -.018 : Math.sin(time * .00062) * .012;
      avatar.position.y = .05 + Math.sin(time * .00105) * .012;
      armsGroup.rotation.y = state.mayaSpeaking ? Math.sin(time * .0022) * .012 : 0;
      armsGroup.position.y = state.mayaSpeaking ? Math.sin(time * .0022 + 1.2) * .006 : 0;
      halo.rotation.z = time * .00004;
      renderer.render(scene, camera);
      requestAnimationFrame(animate);
    };
    requestAnimationFrame(animate);
    state.avatar = { renderer, scene, avatar, headGroup };
  } catch {
    // The CSS avatar remains available if WebGL or the module CDN is unavailable.
  }
}

$("#privacyOpen").addEventListener("click", () => $("#privacyDialog").showModal());
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => $("#privacyDialog").close()));
$("#coachingFeedback").addEventListener("click", () => {
  const kind = state.activeCoachingKind;
  if (!kind) return;
  sendVisionTelemetry("feedback", kind);
  state.dismissedCues.add(kind);
  state.conditions.delete(kind);
  state.activeCoachingKind = "";
  state.pendingVisionCue = null;
  $("#coachingBanner").hidden = true;
  $("#coachingFeedback").hidden = true;
  toast("Thanks—this cue was marked inaccurate for calibration.");
});

$("#endInterview").addEventListener("click", () => {
  if (confirm("End this session and prepare the recap?")) completeInterview("candidate_ended");
});

async function completeInterview(reason = "candidate_ended") {
  if (state.completing) return;
  state.completing = true;
  state.completionReason = reason;
  clearInterval(state.timer);
  clearInterval(state.visionTelemetryTimer);
  clearInterval(state.visionContextTimer);
  clearInterval(state.integrityTimer);
  clearTimeout(state.integrityWarningTimer);
  hideIntegrityShield();
  await sendVisionTelemetry("complete");
  state.visionRunning = false;
  state.channel?.close();
  state.peer?.close();
  state.remoteAudio?.pause();
  state.remoteAudioSource?.disconnect();
  state.remoteAudioContext?.close().catch(() => {});
  if ("speechSynthesis" in window) speechSynthesis.cancel();
  state.stream?.getTracks().forEach((track) => track.stop());
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  interviewView.hidden = true;
  completeView.hidden = false;
  if (reason === "integrity_timeout") {
    $("#completionTag").textContent = "SESSION INTERRUPTED";
    $("#completionTitle").textContent = "Session ended.";
    $("#completionMessage").textContent = "The interview closed after an unresolved five-second browser, fullscreen, or camera interruption. This is not an automatic cheating finding.";
  }
  $("#finalEventCount").textContent = state.eventCount;
  $("#answeredCount").textContent = state.turnCount;
  $("#totalDuration").textContent = formatDuration(Math.floor((Date.now() - state.startedAt) / 1000));
  updateUsageUi();
  refreshIcons();
  try {
    const payload = await api(`/api/interviews/${state.interviewId}/complete/`, {
      method: "POST",
      body: JSON.stringify({ realtime_usage: state.realtimeUsage, completion_reason: reason }),
    });
    renderSummary(payload.summary);
    $("#answeredCount").textContent = payload.answer_count ?? state.turnCount;
  } catch (error) {
    $("#summaryPanel").innerHTML = `<h3>Session saved</h3><p></p>`;
    $("#summaryPanel p").textContent = `The recap could not be prepared yet: ${error.message}`;
  }
}

function renderSummary(summary = {}) {
  const strengths = Array.isArray(summary.demonstrated) ? summary.demonstrated : [];
  const followups = Array.isArray(summary.follow_up) ? summary.follow_up : [];
  $("#summaryPanel").innerHTML = `
    <h3>Discussion recap</h3>
    <p class="summary-intro"></p>
    <div class="summary-grid">
      <div><h4>DEMONSTRATED IN THE CONVERSATION</h4><ul class="strength-list"></ul></div>
      <div><h4>USEFUL HUMAN FOLLOW-UP</h4><ul class="follow-list"></ul></div>
    </div>`;
  $("#summaryPanel .summary-intro").textContent = summary.overview || "Your conversation was completed and is ready for review.";
  const fill = (selector, items, fallback) => {
    const list = $(selector);
    (items.length ? items : [fallback]).forEach((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      list.appendChild(item);
    });
  };
  fill(".strength-list", strengths, "Review the candidate’s examples and outcomes in the transcript.");
  fill(".follow-list", followups, "Validate role-specific depth in a human follow-up.");
}

$("#newInterview").addEventListener("click", () => window.location.reload());

window.addEventListener("beforeunload", (event) => {
  if (!interviewView.hidden && !state.completing) {
    event.preventDefault();
    event.returnValue = "";
  }
});
