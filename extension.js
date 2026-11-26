/*
 * LocalFill - Spicetify extension for replacing unavailable Spotify tracks
 * with local audio files.
 *
 * No build step is required. The extension is a single plain-JavaScript file.
 */
(function () {
  "use strict";

  /* ------------------------------------------------------------------ */
  /* Pure helpers (also exported for Node tests)                        */
  /* ------------------------------------------------------------------ */

  const AUDIO_EXTENSIONS = new Set([
    "aac",
    "aif",
    "aiff",
    "alac",
    "flac",
    "m4a",
    "mp3",
    "oga",
    "ogg",
    "opus",
    "wav",
    "webm",
    "wma",
  ]);

  const DEFAULT_SETTINGS = {
    autoPlay: true,
    showPill: true,
    overridePlayable: false,
    syncVolume: true,
    localVolume: 1,
    preemptMs: 1500,
    matchThreshold: 0.5,
  };

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function normalizeText(value) {
    return String(value == null ? "" : value)
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/\[[^\]]*\]|\([^)]*\)/g, " ")
      .replace(
        /\b(feat|ft|featuring|official|video|lyrics?|audio|remaster|remastered|version|mv|hd|hq|explicit)\b/g,
        " ",
      )
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function normalizeFileName(name) {
    return normalizeText(
      String(name == null ? "" : name)
        .replace(/\.[^.\\/]+$/, "")
        .replace(/^\s*\d{1,3}[\s._-]+/, ""),
    );
  }

  function bigrams(value) {
    const result = [];
    for (let index = 0; index < value.length - 1; index += 1) {
      result.push(value.slice(index, index + 2));
    }
    return result;
  }

  function diceCoefficient(first, second) {
    const a = String(first == null ? "" : first);
    const b = String(second == null ? "" : second);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;

    const aPairs = bigrams(a);
    const bPairs = bigrams(b);
    const counts = new Map();
    for (const pair of aPairs) {
      counts.set(pair, (counts.get(pair) || 0) + 1);
    }

    let intersection = 0;
    for (const pair of bPairs) {
      const count = counts.get(pair) || 0;
      if (count > 0) {
        intersection += 1;
        counts.set(pair, count - 1);
      }
    }

    return (2 * intersection) / (aPairs.length + bPairs.length);
  }

  function scoreMatch(track, fileName) {
    const title = normalizeText(track && (track.title || track.name));
    const artistsValue = track && (track.artists || track.artist);
    const artists = normalizeText(
      [].concat(artistsValue || [])
        .map((artist) =>
          typeof artist === "string"
            ? artist
            : artist && (artist.name || (artist.profile && artist.profile.name)),
        )
        .filter(Boolean)
        .join(" "),
    );
    const album = normalizeText(
      track && (track.album && track.album.name ? track.album.name : track.album || track.albumName),
    );
    const candidate = normalizeFileName(fileName);
    if (!candidate) return 0;

    const titleScore = diceCoefficient(candidate, title);
    const artistScore = artists ? diceCoefficient(candidate, artists) : 0;
    const albumScore = album ? diceCoefficient(candidate, album) : 0;
    const containsTitle = title && candidate.includes(title) ? 1 : 0;
    const containsArtist = artists && candidate.includes(artists) ? 1 : 0;

    const candidateTokens = candidate.split(" ").filter((token) => token.length > 1);
    const titleTokens = title.split(" ").filter((token) => token.length > 1);
    const overlap = titleTokens.length
      ? titleTokens.filter((token) => candidateTokens.includes(token)).length / titleTokens.length
      : 0;

    return clamp(
      0.42 * titleScore +
        0.18 * overlap +
        0.2 * Math.max(artistScore, containsArtist) +
        0.1 * albumScore +
        0.1 * containsTitle,
      0,
      1,
    );
  }

  function matchTracksToFiles(tracks, files, threshold) {
    const minScore = threshold == null ? DEFAULT_SETTINGS.matchThreshold : threshold;
    const fileList = Array.from(files || []);
    const matches = new Map();

    for (const track of Array.from(tracks || [])) {
      if (!track || !track.uri) continue;
      let best = null;
      for (const file of fileList) {
        const name = file && (file.name || file.fileName || file.path);
        if (!name) continue;
        const score = scoreMatch(track, name);
        if (!best || score > best.score) {
          best = { file, score };
        }
      }
      if (best && best.score >= minScore) {
        matches.set(track.uri, best);
      }
    }

    return matches;
  }

  function isAudioFileName(name) {
    const match = String(name == null ? "" : name).match(/\.([^.\\/]+)$/);
    return !!match && AUDIO_EXTENSIONS.has(match[1].toLowerCase());
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
    const whole = Math.floor(seconds);
    const minutes = Math.floor(whole / 60);
    const remainder = whole % 60;
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  }

  function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return `${(bytes / Math.pow(1024, exponent)).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
  }

  if (typeof module !== "undefined" && module.exports) {
    module.exports = {
      AUDIO_EXTENSIONS,
      DEFAULT_SETTINGS,
      clamp,
      normalizeText,
      normalizeFileName,
      diceCoefficient,
      scoreMatch,
      matchTracksToFiles,
      isAudioFileName,
      formatTime,
      formatBytes,
    };
    return;
  }

  /* ------------------------------------------------------------------ */
  /* Extension constants and state                                      */
  /* ------------------------------------------------------------------ */

  const DB_NAME = "localfill";
  const DB_VERSION = 1;
  const SETTINGS_STORAGE_KEY = "localfill:settings";
  const STORE_META = "meta";
  const STORE_FILES = "files";
  const STORE_SETTINGS = "settings";

  const state = {
    settings: { ...DEFAULT_SETTINGS },
    mapIndex: new Map(),
    playerMode: "spotify",
    local: null,
    preempting: false,
    advancing: false,
    preemptedFor: null,
    parkedTrackUri: null,
    contextCache: null,
    lastDirectPlay: null,
  };

  let dbPromise = null;
  let audio = null;
  let pillElement = null;
  let reconcilePromise = null;
  let rowIndicatorObserver = null;
  let rowIndicatorTimer = null;

  /* ------------------------------------------------------------------ */
  /* IndexedDB                                                          */
  /* ------------------------------------------------------------------ */

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is not available"));
        return;
      }
      const request = window.indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: "uri" });
        }
        if (!db.objectStoreNames.contains(STORE_FILES)) {
          db.createObjectStore(STORE_FILES, { keyPath: "uri" });
        }
        if (!db.objectStoreNames.contains(STORE_SETTINGS)) {
          db.createObjectStore(STORE_SETTINGS, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Could not open LocalFill storage"));
    });
    return dbPromise;
  }

  function idbRead(storeName, key) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error || transaction.error);
        }),
    );
  }

  function idbReadAll(storeName) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readonly");
          const request = transaction.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result || []);
          request.onerror = () => reject(request.error || transaction.error);
        }),
    );
  }

  function idbWrite(storeName, operation) {
    return openDb().then(
      (db) =>
        new Promise((resolve, reject) => {
          const transaction = db.transaction(storeName, "readwrite");
          const request = operation(transaction.objectStore(storeName));
          let result;
          request.onsuccess = () => {
            result = request.result;
          };
          transaction.oncomplete = () => resolve(result);
          transaction.onerror = () => reject(transaction.error || request.error);
          transaction.onabort = () => reject(transaction.error || new Error("LocalFill storage transaction aborted"));
        }),
    );
  }

  function idbPut(storeName, value) {
    return idbWrite(storeName, (store) => store.put(value));
  }

  function idbDelete(storeName, key) {
    return idbWrite(storeName, (store) => store.delete(key));
  }

  /* ------------------------------------------------------------------ */
  /* Settings and mapping store                                         */
  /* ------------------------------------------------------------------ */

  function loadLocalSettings() {
    let saved = {};
    try {
      saved = JSON.parse(window.localStorage.getItem(SETTINGS_STORAGE_KEY) || "{}") || {};
    } catch (error) {
      console.warn("[LocalFill] Could not read local settings", error);
    }
    state.settings = { ...DEFAULT_SETTINGS, ...saved };
  }

  async function loadPersistedSettings() {
    loadLocalSettings();
    try {
      const record = await idbRead(STORE_SETTINGS, "main");
      if (record && record.value && !window.localStorage.getItem(SETTINGS_STORAGE_KEY)) {
        state.settings = { ...DEFAULT_SETTINGS, ...record.value };
      }
    } catch (error) {
      console.warn("[LocalFill] Could not read settings from storage", error);
    }
  }

  function saveSettings() {
    try {
      window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(state.settings));
    } catch (error) {
      console.warn("[LocalFill] Could not save local settings", error);
    }
    idbPut(STORE_SETTINGS, { key: "main", value: { ...state.settings } }).catch((error) => {
      console.warn("[LocalFill] Could not save settings to storage", error);
    });
  }

  async function loadMappings() {
    const records = await idbReadAll(STORE_META);
    state.mapIndex = new Map(
      records.filter((record) => record && record.uri).map((record) => [record.uri, record]),
    );
  }

  function getMapping(uri) {
    return state.mapIndex.get(uri) || null;
  }

  function extractTrackInfo(source) {
    const row = source || {};
    const track = row.track && row.track.uri ? row.track : row.item && row.item.uri ? row.item : row;
    const uri = track.uri || row.uri || "";
    const id = track.id || (uri.startsWith("spotify:track:") ? uri.split(":").pop() : "");
    const albumObject = track.album || row.album || {};
    const artistsValue = track.artists || row.artists || track.artist || row.artist || [];
    const artists = (Array.isArray(artistsValue) ? artistsValue : [artistsValue])
      .map((artist) => {
        if (!artist) return "";
        if (typeof artist === "string") return artist;
        return artist.name || (artist.profile && artist.profile.name) || "";
      })
      .filter(Boolean);
    const playableValue =
      track.isPlayable != null
        ? track.isPlayable
        : track.is_playable != null
          ? track.is_playable
          : row.playable != null
            ? row.playable
            : track.playable != null
              ? track.playable
              : track.playability && track.playability.playable != null
                ? track.playability.playable
                : undefined;
    const imageList =
      (albumObject && albumObject.images) || track.images || (row.album && row.album.images) || [];
    const duration = track.duration && track.duration.milliseconds;

    return {
      uri,
      id,
      title:
        track.name || track.title || track.trackName || (track.metadata && track.metadata.title) || "",
      artists,
      album: (albumObject && albumObject.name) || track.album_name || track.albumName || "",
      albumArt: (imageList && imageList[0] && imageList[0].url) || track.image || track.albumArt || "",
      spotifyDurationMs: duration || track.duration_ms || track.durationMs || 0,
      isUnavailable: playableValue === false,
      isLocal: !!track.isLocal,
    };
  }

  function getCurrentUri() {
    try {
      return (
        (Spicetify.Player.data && Spicetify.Player.data.item && Spicetify.Player.data.item.uri) ||
        null
      );
    } catch (error) {
      return null;
    }
  }

  function getCurrentTrackInfo() {
    try {
      return extractTrackInfo(Spicetify.Player.data && Spicetify.Player.data.item);
    } catch (error) {
      return null;
    }
  }

  function isTrackUri(uri) {
    return /^spotify:track:[A-Za-z0-9]+$/.test(String(uri || ""));
  }

  function isPlaylistUri(uri) {
    return /^spotify:(playlist:[A-Za-z0-9]+|collection:tracks)$/.test(String(uri || ""));
  }

  function playlistIdFromUri(uri) {
    const match = String(uri || "").match(/^spotify:playlist:([A-Za-z0-9]+)$/);
    return match ? match[1] : null;
  }

  async function fetchWebTrack(uri) {
    const id = uri.startsWith("spotify:track:") ? uri.split(":").pop() : "";
    if (!id || !Spicetify.CosmosAsync) throw new Error("Track metadata API is unavailable");
    const data = await Spicetify.CosmosAsync.get(
      `https://api.spotify.com/v1/tracks/${encodeURIComponent(id)}`,
    );
    return {
      uri: data.uri || uri,
      id: data.id || id,
      title: data.name || "",
      artists: (data.artists || []).map((artist) => artist.name).filter(Boolean),
      album: (data.album && data.album.name) || "",
      albumArt:
        (data.album &&
          data.album.images &&
          data.album.images[0] &&
          data.album.images[0].url) ||
        "",
      spotifyDurationMs: data.duration_ms || 0,
      isUnavailable: data.is_playable === false,
      isLocal: false,
    };
  }

  async function fetchTrackInfo(uri) {
    const current = getCurrentUri();
    if (current === uri) {
      const currentInfo = getCurrentTrackInfo();
      try {
        const webInfo = await fetchWebTrack(uri);
        return {
          ...currentInfo,
          ...webInfo,
          albumArt: webInfo.albumArt || currentInfo.albumArt,
          spotifyDurationMs: webInfo.spotifyDurationMs || currentInfo.spotifyDurationMs,
          isUnavailable: webInfo.isUnavailable,
        };
      } catch (error) {
        return currentInfo || extractTrackInfo({ uri });
      }
    }
    try {
      return await fetchWebTrack(uri);
    } catch (error) {
      return extractTrackInfo({ uri });
    }
  }

  async function getAudioDuration(file) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(file);
      const probe = document.createElement("audio");
      let finished = false;
      let timer = null;

      const finish = (duration) => {
        if (finished) return;
        finished = true;
        if (timer) window.clearTimeout(timer);
        probe.removeAttribute("src");
        try {
          probe.load();
        } catch (error) {
          /* ignore */
        }
        URL.revokeObjectURL(url);
        resolve(duration);
      };

      timer = window.setTimeout(() => finish(0), 5000);
      probe.preload = "metadata";
      probe.onloadedmetadata = () => {
        const duration = Number.isFinite(probe.duration) ? Math.round(probe.duration * 1000) : 0;
        finish(duration);
      };
      probe.onerror = () => finish(0);
      probe.src = url;
    });
  }

  async function saveMapping(uri, file, trackInfo) {
    if (!uri || !file) throw new Error("A track and audio file are required");
    if (!isAudioFileName(file.name) && !(file.type && file.type.startsWith("audio/"))) {
      throw new Error("The selected file is not a supported audio file");
    }

    const info = trackInfo || (await fetchTrackInfo(uri)) || extractTrackInfo({ uri });
    const existing = getMapping(uri);
    const localDurationMs = await getAudioDuration(file);

    const meta = {
      uri,
      id: info.id || "",
      title: info.title || file.name,
      artists: info.artists || [],
      album: info.album || "",
      albumArt: info.albumArt || "",
      spotifyDurationMs: info.spotifyDurationMs || 0,
      isUnavailable: !!info.isUnavailable,
      isLocal: !!info.isLocal,
      fileName: file.name,
      fileSize: file.size || 0,
      mimeType: file.type || "",
      localDurationMs,
      addedAt: existing && existing.addedAt ? existing.addedAt : Date.now(),
      updatedAt: Date.now(),
    };

    await idbPut(STORE_META, meta);
    try {
      await idbPut(STORE_FILES, {
        uri,
        blob: file,
        fileName: file.name,
        mimeType: file.type || "",
        size: file.size || 0,
      });
    } catch (error) {
      await idbDelete(STORE_META, uri).catch(() => {});
      throw new Error(`Could not store the audio file: ${error.message || error}`);
    }

    state.mapIndex.set(uri, meta);
    refreshRowIndicators();
    return meta;
  }

  async function removeMapping(uri, options) {
    const settings = options || {};
    const meta = getMapping(uri);
    if (!meta) {
      if (!settings.silent) notify("No local file is mapped for this track.");
      return false;
    }

    await idbDelete(STORE_META, uri).catch((error) => {
      console.warn("[LocalFill] Could not delete mapping metadata", error);
    });
    await idbDelete(STORE_FILES, uri).catch((error) => {
      console.warn("[LocalFill] Could not delete stored audio", error);
    });

    state.mapIndex.delete(uri);
    if (state.local && state.local.uri === uri) {
      stopLocal({ hidePill: true });
    }
    refreshRowIndicators();
    if (!settings.silent) notify(`Removed local file for "${meta.title}".`);
    return true;
  }

  async function clearAllMappings() {
    const uris = Array.from(state.mapIndex.keys());
    for (const uri of uris) {
      await removeMapping(uri, { silent: true });
    }
    notify(`Cleared ${uris.length} local replacement(s).`);
  }

  /* ------------------------------------------------------------------ */
  /* Notifications and context                                          */
  /* ------------------------------------------------------------------ */

  function notify(message, isError) {
    const text = String(message == null ? "" : message);
    if (isError) console.error("[LocalFill]", text);
    else console.log("[LocalFill]", text);
    try {
      if (Spicetify.showNotification) Spicetify.showNotification(text, !!isError);
    } catch (error) {
      /* ignore */
    }
  }

  function getPlaylistContext() {
    try {
      const history = Spicetify.Platform && Spicetify.Platform.History;
      const pathname =
        (history && history.location && history.location.pathname) ||
        window.location.pathname ||
        "";
      const playlistMatch = pathname.match(/^\/playlist\/([A-Za-z0-9]+)/);
      if (playlistMatch) {
        return { type: "playlist", uri: `spotify:playlist:${playlistMatch[1]}` };
      }
      if (pathname.startsWith("/collection/tracks")) {
        return { type: "liked", uri: "spotify:collection:tracks" };
      }
    } catch (error) {
      console.warn("[LocalFill] Could not detect the current route", error);
    }
    return null;
  }

  const TRACK_ROW_SELECTOR =
    '[data-testid="tracklist-row"], .main-trackList-trackListRow, [role="row"][aria-rowindex]';

  function trackUriFromHref(href) {
    const match = String(href || "").match(/\/track\/([A-Za-z0-9]+)/);
    return match ? `spotify:track:${match[1]}` : null;
  }

  function getTrackUriFromRow(row) {
    if (!row) return null;
    for (const attribute of ["data-uri", "data-track-uri"]) {
      const value = row.getAttribute(attribute);
      if (value && value.startsWith("spotify:track:")) return value;
    }
    const link = row.querySelector('[data-testid="internal-track-link"], a[href*="/track/"]');
    if (link) {
      const uri = trackUriFromHref(link.getAttribute("href"));
      if (uri) return uri;
    }
    const node = row.querySelector("[data-uri^='spotify:track:'], [data-track-uri^='spotify:track:']");
    if (node) {
      const value = node.getAttribute("data-uri") || node.getAttribute("data-track-uri");
      if (value && value.startsWith("spotify:track:")) return value;
    }
    return null;
  }

  function isInsideNonPlayControl(target) {
    if (target.closest("a[href]")) return true;
    if (target.closest(".main-trackList-rowImagePlayButton")) return false;
    const control = target.closest("button, [role='button']");
    if (!control) return false;
    const testId = control.getAttribute("data-testid") || "";
    const label = (control.getAttribute("aria-label") || "").toLowerCase();
    const isPlayButton =
      testId === "play-button" ||
      control.classList.contains("main-trackList-rowImagePlayButton") ||
      label.startsWith("play") ||
      label.startsWith("pause");
    return !isPlayButton;
  }

  function rowTitleText(row) {
    const node = row && row.querySelector(".main-trackList-rowMainContentTitle");
    return node ? node.textContent.trim() : "";
  }

  function rowArtistText(row) {
    const node = row && row.querySelector(".main-trackList-rowMainContentSubTitle");
    if (!node) return "";
    return Array.from(node.querySelectorAll("a"))
      .map((link) => link.textContent.trim())
      .filter(Boolean)
      .join(" ");
  }

  function mappingFromRow(row) {
    const normalizedTitle = normalizeText(rowTitleText(row));
    if (!normalizedTitle) return null;
    const normalizedArtists = normalizeText(rowArtistText(row));
    let best = null;
    let bestScore = 0;

    for (const mapping of state.mapIndex.values()) {
      const candidate = normalizeFileName(mapping.fileName || mapping.title || "");
      if (!candidate) continue;
      let score = 0;
      if (candidate === normalizedTitle) score = 100;
      else if (candidate.includes(normalizedTitle) || normalizedTitle.includes(candidate)) score = 50;
      else continue;

      const mappingArtists = normalizeText(
        Array.isArray(mapping.artists) ? mapping.artists.join(" ") : mapping.artists || "",
      );
      if (
        normalizedArtists &&
        mappingArtists &&
        (normalizedArtists.includes(mappingArtists) || mappingArtists.includes(normalizedArtists))
      ) {
        score += 25;
      }

      if (score > bestScore) {
        bestScore = score;
        best = mapping;
      }
    }

    return bestScore >= 100 ? best : null;
  }

  function mappingForRow(row) {
    const uri = getTrackUriFromRow(row);
    if (uri) {
      const mapping = getMapping(uri);
      if (mapping) return mapping;
    }
    return mappingFromRow(row);
  }

  function refreshRowIndicator(row) {
    if (!row || !row.isConnected) return;
    const end = row.querySelector(".main-trackList-rowSectionEnd");
    if (!end) return;
    const mapping = mappingForRow(row);
    let badge = row.querySelector(".localfill-row-indicator");

    if (!mapping) {
      if (badge) badge.remove();
      return;
    }

    if (!badge) {
      badge = element("span", "localfill-row-indicator", "LOCAL");
      badge.title = "Local file available";
      badge.setAttribute("aria-label", "Local file available");
      end.insertBefore(badge, end.firstChild);
    }
  }

  function refreshRowIndicators() {
    document.querySelectorAll(TRACK_ROW_SELECTOR).forEach(refreshRowIndicator);
  }

  function setupRowIndicators() {
    refreshRowIndicators();
    if (rowIndicatorObserver) rowIndicatorObserver.disconnect();
    rowIndicatorObserver = new MutationObserver((mutations) => {
      let relevant = false;
      for (const mutation of mutations) {
        if (mutation.type !== "childList") continue;
        for (const node of mutation.addedNodes) {
          if (
            node.nodeType === 1 &&
            (node.matches(TRACK_ROW_SELECTOR) || node.querySelector(TRACK_ROW_SELECTOR))
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        for (const node of mutation.removedNodes) {
          if (
            node.nodeType === 1 &&
            (node.matches(TRACK_ROW_SELECTOR) || node.querySelector(TRACK_ROW_SELECTOR))
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
        const target = mutation.target;
        const row =
          target.nodeType === 1
            ? target.closest(TRACK_ROW_SELECTOR)
            : target.parentElement && target.parentElement.closest(TRACK_ROW_SELECTOR);
        if (row) {
          relevant = true;
          break;
        }
      }
      if (!relevant) return;
      if (rowIndicatorTimer) return;
      rowIndicatorTimer = window.setTimeout(() => {
        rowIndicatorTimer = null;
        refreshRowIndicators();
      }, 150);
    });
    rowIndicatorObserver.observe(document.body, { childList: true, subtree: true });
    return true;
  }

  function getDirectPlayMapping(target) {
    const row = target.closest(TRACK_ROW_SELECTOR);
    if (row) {
      if (isInsideNonPlayControl(target)) return null;
      const uri = getTrackUriFromRow(row);
      if (uri) return getMapping(uri);
      return mappingFromRow(row);
    }

    const playButton = target.closest('button[data-testid="play-button"]');
    if (!playButton) return null;
    const pathname =
      (Spicetify.Platform &&
        Spicetify.Platform.History &&
        Spicetify.Platform.History.location &&
        Spicetify.Platform.History.location.pathname) ||
      window.location.pathname ||
      "";
    const uri = trackUriFromHref(pathname);
    return uri ? getMapping(uri) : null;
  }

  function onDirectPlay(event) {
    const target = event.target;
    if (!target || !target.closest) return;
    const mapping = getDirectPlayMapping(target);
    if (!mapping) return;
    if (!mapping.isUnavailable && !state.settings.autoPlay && !state.settings.overridePlayable) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const uri = mapping.uri;
    const now = Date.now();
    if (
      state.lastDirectPlay &&
      state.lastDirectPlay.uri === uri &&
      now - state.lastDirectPlay.at < 1200
    ) {
      return;
    }
    state.lastDirectPlay = { uri, at: now };

    if (state.local && state.local.uri === uri) {
      toggleLocal();
      return;
    }
    playLocalNow(uri).catch((error) => {
      notify(`Could not play the local file: ${error.message || error}`, true);
    });
  }

  /* ------------------------------------------------------------------ */
  /* File and folder pickers                                            */
  /* ------------------------------------------------------------------ */

  function pickFile(options) {
    const config = options || {};
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = config.accept || "audio/*";
      input.style.cssText =
        "position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;opacity:0;";
      if (config.directory) {
        input.multiple = true;
        input.setAttribute("webkitdirectory", "");
        input.setAttribute("directory", "");
      }
      document.body.appendChild(input);

      let finished = false;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        input.remove();
        resolve(value);
      };

      input.addEventListener(
        "change",
        () => {
          const files = Array.from(input.files || []);
          finish(config.directory ? files : files[0] || null);
        },
        { once: true },
      );
      input.addEventListener("cancel", () => finish(config.directory ? [] : null), { once: true });
      window.setTimeout(() => finish(config.directory ? [] : null), 120000);

      input.click();
    });
  }

  function pickAudioFile() {
    return pickFile({ accept: "audio/*" });
  }

  function pickFolderFiles() {
    return pickFile({ directory: true });
  }

  /* ------------------------------------------------------------------ */
  /* Audio playback                                                     */
  /* ------------------------------------------------------------------ */

  const ICONS = {
    play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2.2v11.6c0 .6.7 1 1.2.7l9.1-5.8c.5-.3.5-1 0-1.3L5.2 1.5C4.7 1.2 4 1.6 4 2.2z"/></svg>',
    pause:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 2h3v12H4V2zm5 0h3v12H9V2z"/></svg>',
    next: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 2.5v11c0 .6.7 1 1.2.7l7-5.5c.4-.3.4-.9 0-1.2l-7-5.5C3.7 1.5 3 1.9 3 2.5zM12.5 2H14v12h-1.5V2z"/></svg>',
    stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M4 4h8v8H4V4z"/></svg>',
    volume:
      '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 6h2l3-2.4v8.8L4 10H2V6zm7.6-1.1a3.8 3.8 0 0 1 0 6.2V9.5a2.3 2.3 0 0 0 0-3V4.9z"/></svg>',
  };

  function pauseSpotify() {
    try {
      if (Spicetify.Player && Spicetify.Player.isPlaying && Spicetify.Player.isPlaying()) {
        Spicetify.Player.pause();
      }
    } catch (error) {
      console.warn("[LocalFill] Could not pause Spotify", error);
    }
  }

  function syncLocalVolume() {
    if (!audio) return;
    try {
      const spotifyVolume = Spicetify.Player.getVolume ? Spicetify.Player.getVolume() : 1;
      const muted = Spicetify.Player.getMute ? Spicetify.Player.getMute() : false;
      if (state.settings.syncVolume) {
        audio.volume = clamp(Number(spotifyVolume), 0, 1);
        audio.muted = !!muted;
      } else {
        const localVolume = Number(state.settings.localVolume);
        audio.volume = clamp(Number.isFinite(localVolume) ? localVolume : 1, 0, 1);
        audio.muted = false;
      }
    } catch (error) {
      /* ignore */
    }
    if (pillElement) {
      const slider = pillElement.querySelector(".localfill-pill-volume-slider");
      if (slider) slider.value = String(Math.round(clamp(audio.volume, 0, 1) * 100));
    }
  }

  function buildPill() {
    if (pillElement) return pillElement;
    const node = document.createElement("div");
    node.className = "localfill-pill";
    node.innerHTML = `
      <div class="localfill-pill-main">
        <img class="localfill-pill-art" alt="" />
        <div class="localfill-pill-text">
          <div class="localfill-pill-title"></div>
          <div class="localfill-pill-artist"></div>
        </div>
        <div class="localfill-pill-buttons">
          <button class="localfill-icon-button localfill-pill-play" type="button" aria-label="Play local file"></button>
          <button class="localfill-icon-button localfill-pill-next" type="button" aria-label="Next track"></button>
          <button class="localfill-icon-button localfill-pill-stop" type="button" aria-label="Stop local file"></button>
        </div>
      </div>
      <div class="localfill-pill-progress">
        <span class="localfill-pill-current">0:00</span>
        <input class="localfill-pill-seek" type="range" min="0" max="1000" step="1" value="0" aria-label="Seek local file" />
        <span class="localfill-pill-duration">0:00</span>
        <label class="localfill-pill-volume" title="Local file volume">
          <span class="localfill-pill-volume-icon" aria-hidden="true"></span>
          <input class="localfill-pill-volume-slider" type="range" min="0" max="100" step="1" value="100" aria-label="Local file volume" />
        </label>
      </div>
      <div class="localfill-pill-badge">LOCAL FILE</div>
    `;

    node.querySelector(".localfill-pill-play").innerHTML = ICONS.play;
    node.querySelector(".localfill-pill-next").innerHTML = ICONS.next;
    node.querySelector(".localfill-pill-stop").innerHTML = ICONS.stop;
    node.querySelector(".localfill-pill-volume-icon").innerHTML = ICONS.volume;

    node.querySelector(".localfill-pill-play").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleLocal();
    });
    node.querySelector(".localfill-pill-next").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      playNextLocalOrAdvance();
    });
    node.querySelector(".localfill-pill-stop").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      stopLocal({ hidePill: true });
    });

    const seek = node.querySelector(".localfill-pill-seek");
    seek.addEventListener("input", () => {
      if (!audio || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
      audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
    });

    const volumeSlider = node.querySelector(".localfill-pill-volume-slider");
    volumeSlider.addEventListener("input", () => {
      state.settings.syncVolume = false;
      state.settings.localVolume = clamp(Number(volumeSlider.value) / 100, 0, 1);
      saveSettings();
      syncLocalVolume();
    });

    document.body.appendChild(node);
    pillElement = node;
    return node;
  }

  function setPillVisible(visible) {
    if (!pillElement) return;
    const shouldShow = !!visible && state.settings.showPill;
    pillElement.classList.toggle("is-visible", shouldShow);
  }

  function updatePill() {
    if (!pillElement || !state.local || !audio) return;
    const meta = state.local.meta;
    const title = pillElement.querySelector(".localfill-pill-title");
    const artist = pillElement.querySelector(".localfill-pill-artist");
    const art = pillElement.querySelector(".localfill-pill-art");
    const playButton = pillElement.querySelector(".localfill-pill-play");
    const seek = pillElement.querySelector(".localfill-pill-seek");
    const current = pillElement.querySelector(".localfill-pill-current");
    const duration = pillElement.querySelector(".localfill-pill-duration");
    const badge = pillElement.querySelector(".localfill-pill-badge");
    const volumeSlider = pillElement.querySelector(".localfill-pill-volume-slider");

    title.textContent = meta.title || meta.fileName || "Local file";
    artist.textContent =
      (meta.artists && meta.artists.length ? meta.artists.join(", ") : meta.fileName) || "";
    if (meta.albumArt) {
      art.src = meta.albumArt;
      art.style.visibility = "visible";
    } else {
      art.removeAttribute("src");
      art.style.visibility = "hidden";
    }
    art.alt = meta.album || "";

    const isPlaying = !audio.paused && !audio.ended;
    playButton.innerHTML = isPlaying ? ICONS.pause : ICONS.play;
    playButton.setAttribute("aria-label", isPlaying ? "Pause local file" : "Play local file");

    const total =
      Number.isFinite(audio.duration) && audio.duration > 0
        ? audio.duration
        : (meta.localDurationMs || 0) / 1000;
    const position = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    seek.value = total > 0 ? String(Math.round((position / total) * 1000)) : "0";
    current.textContent = formatTime(position);
    duration.textContent = formatTime(total);
    if (volumeSlider) volumeSlider.value = String(Math.round(clamp(audio.volume || 0, 0, 1) * 100));
    badge.textContent = meta.isUnavailable ? "LOCAL FILE" : "LOCAL OVERRIDE";
  }

  function setupAudio() {
    audio = new Audio();
    audio.preload = "metadata";
    audio.setAttribute("aria-hidden", "true");
    audio.style.display = "none";
    document.body.appendChild(audio);
    audio.addEventListener("timeupdate", updatePill);
    audio.addEventListener("durationchange", updatePill);
    audio.addEventListener("play", updatePill);
    audio.addEventListener("pause", updatePill);
    audio.addEventListener("ended", onLocalEnded);
    audio.addEventListener("error", onLocalError);
  }

  async function startLocalPlayback(uri, options) {
    const config = options || {};
    const meta = getMapping(uri);
    if (!meta) {
      notify("No local file is mapped for this track.", true);
      return false;
    }

    let record;
    try {
      record = await idbRead(STORE_FILES, uri);
    } catch (error) {
      notify(`Could not read the stored audio file: ${error.message || error}`, true);
      return false;
    }
    if (!record || !record.blob) {
      notify("The stored audio file is missing. Choose the file again.", true);
      return false;
    }

    if (state.local && state.local.uri === uri && !config.restart && audio) {
      state.local.autoAdvance =
        config.autoAdvance != null ? !!config.autoAdvance : state.local.autoAdvance;
      setPillVisible(true);
      if (audio.paused) {
        try {
          await audio.play();
        } catch (error) {
          notify("Press play in LocalFill to start the local file.", false);
        }
      }
      updatePill();
      return true;
    }

    if (config.pauseSpotify !== false) pauseSpotify();
    stopLocal({ hidePill: false, keepSpotifyPaused: true });

    const url = URL.createObjectURL(record.blob);
    state.local = {
      uri,
      meta,
      url,
      autoAdvance: config.autoAdvance != null ? !!config.autoAdvance : true,
      reason: config.reason || "manual",
      chain: Array.isArray(config.chain) ? config.chain.slice() : [],
      startedAt: Date.now(),
      ending: false,
      resumeUri: config.resumeUri || null,
      fromUri: config.fromUri || state.parkedTrackUri || getCurrentUri(),
      preempted: Array.isArray(config.preempted) ? config.preempted.slice() : [],
    };
    state.playerMode = "local";

    audio.src = url;
    audio.currentTime = 0;
    syncLocalVolume();
    buildPill();
    setPillVisible(true);
    updatePill();

    if (config.autoplay === false) {
      updatePill();
      return true;
    }

    try {
      await audio.play();
    } catch (error) {
      if (error && error.name === "NotAllowedError") {
        notify("Press play in LocalFill to start the local file.", false);
      } else {
        notify(`Could not play the local file: ${error.message || error}`, true);
      }
    }
    updatePill();
    return true;
  }

  function stopLocal(options) {
    const config = options || {};
    const local = state.local;
    state.local = null;
    state.playerMode = "spotify";
    if (audio) {
      try {
        audio.pause();
      } catch (error) {
        /* ignore */
      }
      audio.removeAttribute("src");
      try {
        audio.load();
      } catch (error) {
        /* ignore */
      }
    }
    if (local && local.url) {
      URL.revokeObjectURL(local.url);
    }
    if (config.hidePill !== false) setPillVisible(false);
  }

  function toggleLocal() {
    if (!state.local || !audio) return;
    if (audio.paused || audio.ended) {
      audio
        .play()
        .catch((error) => notify(`Could not play the local file: ${error.message || error}`, true));
    } else {
      audio.pause();
    }
  }

  function resumeSpotify(targetUri, preemptedUris, fromUri) {
    const target = targetUri || null;
    const preempted = new Set((preemptedUris || []).filter(Boolean));
    const startedFrom = fromUri || getCurrentUri();
    let attempts = 0;
    state.advancing = true;

    const finish = (message) => {
      state.advancing = false;
      try {
        Spicetify.Player.play();
      } catch (error) {
        notify(message || `Could not resume Spotify: ${error.message || error}`, true);
      }
    };

    if (!target) {
      try {
        Spicetify.Player.next();
      } catch (error) {
        finish(`Could not advance Spotify: ${error.message || error}`);
        return;
      }
      window.setTimeout(() => finish(), 500);
      return;
    }

    const step = () => {
      let current = null;
      try {
        current = getCurrentUri();
      } catch (error) {
        /* ignore */
      }

      if (current && current === target) {
        finish();
        return;
      }
      if (current && current !== startedFrom && !preempted.has(current)) {
        finish();
        return;
      }
      if (attempts >= 12) {
        finish("LocalFill could not find the next Spotify track.");
        return;
      }

      attempts += 1;
      try {
        Spicetify.Player.next();
      } catch (error) {
        finish(`Could not advance Spotify: ${error.message || error}`);
        return;
      }
      window.setTimeout(step, 500);
    };

    step();
  }

  function onLocalEnded() {
    if (!state.local || state.local.ending) return;
    state.local.ending = true;
    const local = state.local;
    const autoAdvance = local.autoAdvance;
    const resumeUri = local.resumeUri || null;
    const preempted = local.preempted || [];
    const fromUri = local.fromUri || null;

    if (local.chain && local.chain.length > 0) {
      const nextUri = local.chain.shift();
      const remainingChain = local.chain;
      stopLocal({ hidePill: false });
      startLocalPlayback(nextUri, {
        autoplay: true,
        autoAdvance,
        reason: "chain",
        chain: remainingChain,
        pauseSpotify: false,
        resumeUri,
        fromUri,
        preempted,
      }).then((started) => {
        if (!started) {
          stopLocal({ hidePill: true });
          if (autoAdvance) resumeSpotify(resumeUri, preempted, fromUri);
        }
      });
      return;
    }

    stopLocal({ hidePill: true });
    if (autoAdvance) resumeSpotify(resumeUri, preempted, fromUri);
  }

  function onLocalError() {
    if (!state.local) return;
    const meta = state.local.meta;
    const autoAdvance = state.local.autoAdvance;
    const resumeUri = state.local.resumeUri || null;
    const preempted = state.local.preempted || [];
    const fromUri = state.local.fromUri || null;
    notify(`The local file for "${meta.title}" could not be played.`, true);
    stopLocal({ hidePill: true });
    if (autoAdvance) resumeSpotify(resumeUri, preempted, fromUri);
  }

  function playNextLocalOrAdvance() {
    if (!state.local) return;
    const local = state.local;
    const autoAdvance = local.autoAdvance;
    const resumeUri = local.resumeUri || null;
    const preempted = local.preempted || [];
    const fromUri = local.fromUri || null;

    if (local.chain && local.chain.length > 0) {
      const nextUri = local.chain.shift();
      const remainingChain = local.chain;
      stopLocal({ hidePill: false });
      startLocalPlayback(nextUri, {
        autoplay: true,
        autoAdvance,
        reason: "chain",
        chain: remainingChain,
        pauseSpotify: false,
        resumeUri,
        fromUri,
        preempted,
      }).then((started) => {
        if (!started) {
          stopLocal({ hidePill: true });
          if (autoAdvance) resumeSpotify(resumeUri, preempted, fromUri);
        }
      });
      return;
    }

    if (
      playUpcomingLocal(local.uri, {
        autoAdvance,
        reason: "skip",
        fromUri,
        parkedTrackUri: state.parkedTrackUri,
        preemptedFor: state.preemptedFor,
      })
    ) {
      return;
    }

    stopLocal({ hidePill: true });
    if (autoAdvance) resumeSpotify(resumeUri, preempted, fromUri);
  }

  async function playLocalNow(uri) {
    const meta = getMapping(uri);
    if (!meta) {
      notify("No local file is mapped for this track.", true);
      return;
    }
    state.parkedTrackUri = getCurrentUri();
    state.preemptedFor = null;
    pauseSpotify();
    const started = await startLocalPlayback(uri, {
      autoplay: true,
      autoAdvance: false,
      reason: "manual",
      chain: [],
      pauseSpotify: false,
    });
    if (started) notify(`Playing local file for "${meta.title}".`);
  }

  /* ------------------------------------------------------------------ */
  /* Auto-skip preemption                                               */
  /* ------------------------------------------------------------------ */

  function normalizeQueueItem(item) {
    if (!item) return null;
    const uri =
      item.uri ||
      (item.contextTrack && item.contextTrack.uri) ||
      (item.track && item.track.uri) ||
      (item.contextTrack && item.contextTrack.contextTrack && item.contextTrack.contextTrack.uri);
    return uri ? { uri, original: item } : null;
  }

  function normalizeQueueList(list) {
    if (!Array.isArray(list)) return [];
    return list.map(normalizeQueueItem).filter(Boolean);
  }

  function upcomingFromContext(baseUri) {
    const context = getPlaylistContext();
    const cache = state.contextCache;
    if (!context || !cache || cache.uri !== context.uri || !Array.isArray(cache.items)) return null;
    const index = cache.items.findIndex((item) => item.uri === baseUri);
    if (index < 0) return null;
    return cache.items
      .slice(index + 1)
      .map(normalizeQueueItem)
      .filter(Boolean);
  }

  function getQueueItems() {
    const sources = [];
    try {
      sources.push(Spicetify.Player && Spicetify.Player.data && Spicetify.Player.data.nextItems);
    } catch (error) {
      /* ignore */
    }
    try {
      if (Spicetify.Platform && Spicetify.Platform.PlayerAPI && Spicetify.Platform.PlayerAPI.getState) {
        sources.push(Spicetify.Platform.PlayerAPI.getState().nextItems);
      }
    } catch (error) {
      /* ignore */
    }
    try {
      if (Spicetify.Queue) sources.push(Spicetify.Queue.nextTracks);
    } catch (error) {
      /* ignore */
    }
    try {
      const queue = Spicetify.Platform && Spicetify.Platform.PlayerAPI && Spicetify.Platform.PlayerAPI._queue;
      if (queue && queue._queueState) {
        sources.push(queue._queueState.nextUp);
        sources.push(queue._queueState.nextItems);
      }
      if (queue && queue._queue) sources.push(queue._queue.nextTracks);
    } catch (error) {
      /* ignore */
    }

    for (const source of sources) {
      const items = normalizeQueueList(source);
      if (items.length > 0) return items;
    }

    return [];
  }

  function isShuffleEnabled() {
    try {
      return !!(Spicetify.Player && Spicetify.Player.getShuffle && Spicetify.Player.getShuffle());
    } catch (error) {
      return false;
    }
  }

  function getUpcomingItems(baseUri) {
    const current = getCurrentUri();
    const base = baseUri || current;
    const contextual = upcomingFromContext(base);
    if (base && base !== current) {
      if (contextual) return contextual;
    }

    const queued = getQueueItems();
    if (contextual && contextual.length > 0 && !isShuffleEnabled()) {
      if (queued.length === 0) return contextual;
      const index = contextual.findIndex((item) => item.uri === queued[0].uri);
      if (index === 0) return contextual;
      if (index > 0 && contextual.slice(0, index).every((item) => shouldPlayLocal(item.uri))) {
        return contextual;
      }
    }

    return queued.length > 0 ? queued : contextual || [];
  }

  function shouldPlayLocal(uri) {
    const mapping = getMapping(uri);
    if (!mapping) return false;
    return mapping.isUnavailable || !!state.settings.overridePlayable;
  }

  function shouldPreemptFor(uri) {
    return shouldPlayLocal(uri);
  }

  function isPlayingRow(row) {
    const button = row && row.querySelector(".main-trackList-rowImagePlayButton");
    const label = button && button.getAttribute("aria-label");
    return /^pause\b/i.test(String(label || ""));
  }

  function collectTrackRows() {
    return Array.from(document.querySelectorAll(TRACK_ROW_SELECTOR)).filter((row) => {
      const button = row.querySelector(".main-trackList-rowImagePlayButton");
      return !!button && button.closest(TRACK_ROW_SELECTOR) === row;
    });
  }

  function localSequenceFromRows(baseUri) {
    const rows = collectTrackRows();
    if (!rows.length) return null;

    let start = -1;
    if (baseUri) {
      start = rows.findIndex((row) => {
        const mapping = mappingForRow(row);
        return mapping && mapping.uri === baseUri;
      });
    }
    if (start < 0) start = rows.findIndex(isPlayingRow);
    if (start < 0) return null;

    const mappings = [];
    let resumeUri = null;
    for (let index = start + 1; index < rows.length; index += 1) {
      const mapping = mappingForRow(rows[index]);
      if (mapping && shouldPlayLocal(mapping.uri)) {
        mappings.push(mapping);
      } else {
        resumeUri = getTrackUriFromRow(rows[index]);
        break;
      }
    }

    if (!mappings.length) return null;
    return {
      nextUri: mappings[0].uri,
      chain: mappings.slice(1).map((mapping) => mapping.uri),
      resumeUri,
    };
  }

  function collectLocalSequence(upcoming) {
    if (!upcoming.length) return null;
    const nextUri = upcoming[0].uri;
    if (!nextUri || !shouldPlayLocal(nextUri)) return null;

    const chain = [];
    let resumeUri = null;
    for (let index = 1; index < upcoming.length; index += 1) {
      const uri = upcoming[index].uri;
      if (shouldPlayLocal(uri)) chain.push(uri);
      else {
        resumeUri = uri;
        break;
      }
    }

    return { nextUri, chain, resumeUri };
  }

  function playUpcomingLocal(baseUri, options) {
    const config = options || {};
    if (!state.settings.autoPlay) return false;
    if (state.preempting || state.advancing) return false;

    const sequence =
      (!isShuffleEnabled() && localSequenceFromRows(baseUri)) ||
      collectLocalSequence(getUpcomingItems(baseUri));
    if (!sequence) return false;

    const fromUri = config.fromUri || getCurrentUri();
    const preempted = [sequence.nextUri, ...sequence.chain];
    state.preempting = true;
    state.preemptedFor = config.preemptedFor || fromUri;
    state.parkedTrackUri = config.parkedTrackUri || state.parkedTrackUri || fromUri;
    pauseSpotify();
    if (state.local && state.local.uri !== sequence.nextUri) stopLocal({ hidePill: false });

    startLocalPlayback(sequence.nextUri, {
      autoplay: true,
      autoAdvance: config.autoAdvance != null ? !!config.autoAdvance : true,
      reason: config.reason || "skip",
      chain: sequence.chain,
      pauseSpotify: false,
      resumeUri: sequence.resumeUri,
      fromUri,
      preempted,
    })
      .then((started) => {
        if (!started) {
          state.preemptedFor = null;
          resumeSpotify(sequence.resumeUri, preempted, fromUri);
        }
      })
      .catch((error) => {
        console.error("[LocalFill] Could not play the upcoming local file", error);
        state.preemptedFor = null;
        notify("LocalFill could not start the local replacement.", true);
      })
      .finally(() => {
        state.preempting = false;
      });

    return true;
  }

  function maybePreempt() {
    if (!state.settings.autoPlay) return;
    if (state.playerMode !== "spotify" || state.preempting || state.advancing) return;
    if (!Spicetify.Player || !Spicetify.Player.isPlaying || !Spicetify.Player.isPlaying()) return;

    let data;
    try {
      data = Spicetify.Player.data;
    } catch (error) {
      return;
    }
    if (!data || !data.item || !data.item.uri) return;

    const duration =
      (Spicetify.Player.getDuration && Spicetify.Player.getDuration()) ||
      (data.duration && data.duration.milliseconds) ||
      (data.item.duration && data.item.duration.milliseconds) ||
      0;
    const progress =
      (Spicetify.Player.getProgress && Spicetify.Player.getProgress()) ||
      (data.progress && data.progress.position) ||
      data.progressMs ||
      0;

    if (!duration || progress < duration - state.settings.preemptMs) return;
    if (state.preemptedFor === data.item.uri) return;

    const upcoming = getUpcomingItems();
    if (!upcoming.length) return;
    const nextUri = upcoming[0].uri;
    if (!nextUri || nextUri === data.item.uri) return;
    if (!shouldPreemptFor(nextUri)) return;

    const chain = [];
    for (let index = 1; index < upcoming.length; index += 1) {
      const uri = upcoming[index].uri;
      if (shouldPlayLocal(uri)) chain.push(uri);
      else break;
    }
    const preempted = [nextUri, ...chain];
    const resumeItem = upcoming[chain.length + 1];
    const resumeUri = resumeItem ? resumeItem.uri : null;

    state.preempting = true;
    state.preemptedFor = data.item.uri;
    state.parkedTrackUri = data.item.uri;
    pauseSpotify();

    startLocalPlayback(nextUri, {
      autoplay: true,
      autoAdvance: true,
      reason: "preempt",
      chain,
      pauseSpotify: false,
      resumeUri,
      fromUri: data.item.uri,
      preempted,
    })
      .then((started) => {
        if (!started) {
          state.preemptedFor = null;
          resumeSpotify(resumeUri, preempted, data.item.uri);
        }
      })
      .catch((error) => {
        console.error("[LocalFill] Preemption failed", error);
        state.preemptedFor = null;
        notify("LocalFill could not start the local replacement.", true);
      })
      .finally(() => {
        state.preempting = false;
      });
  }

  function onSongChange() {
    const uri = getCurrentUri();
    state.preemptedFor = null;
    if (state.advancing) return;
    reconcileContext();

    if (state.playerMode === "local" && state.local) {
      if (!uri || uri === state.local.uri) return;

      const recentlyStarted = Date.now() - state.local.startedAt < 2500;
      if (state.preempting || recentlyStarted) {
        state.local.resumeUri = uri;
        pauseSpotify();
        return;
      }

      stopLocal({ hidePill: true });
    }

    if (!uri) return;
    const mapping = getMapping(uri);
    if (!mapping) return;
    if (!state.settings.autoPlay) return;
    if (!mapping.isUnavailable && !state.settings.overridePlayable) return;
    if (!Spicetify.Player.isPlaying || !Spicetify.Player.isPlaying()) return;

    const upcoming = getUpcomingItems();
    const chain = [];
    let resumeUri = null;
    for (let index = 0; index < upcoming.length; index += 1) {
      const nextUri = upcoming[index].uri;
      if (shouldPlayLocal(nextUri)) chain.push(nextUri);
      else {
        resumeUri = nextUri;
        break;
      }
    }
    const preempted = [uri, ...chain];

    state.parkedTrackUri = uri;
    state.preemptedFor = uri;
    pauseSpotify();
    startLocalPlayback(uri, {
      autoplay: true,
      autoAdvance: true,
      reason: "songchange",
      chain,
      pauseSpotify: false,
      resumeUri,
      fromUri: uri,
      preempted,
    }).then((started) => {
      if (!started) {
        state.preemptedFor = null;
        resumeSpotify(resumeUri, preempted, uri);
      }
    });
  }

  function onPlayPause() {
    if (state.playerMode !== "local" || !audio) return;
    try {
      if (Spicetify.Player.isPlaying && Spicetify.Player.isPlaying()) {
        pauseSpotify();
        if (audio.paused) {
          audio
            .play()
            .catch((error) => notify(`Could not play the local file: ${error.message || error}`, true));
        }
      }
    } catch (error) {
      /* ignore */
    }
  }

  function setupPlayerListeners() {
    if (!Spicetify.Player || !Spicetify.Player.addEventListener) return;
    Spicetify.Player.addEventListener("songchange", onSongChange);
    Spicetify.Player.addEventListener("onprogress", maybePreempt);
    Spicetify.Player.addEventListener("onplaypause", onPlayPause);
    Spicetify.Player.addEventListener("onvolumechange", syncLocalVolume);
    Spicetify.Player.addEventListener("onmute", syncLocalVolume);
    window.setInterval(maybePreempt, 500);
    window.setInterval(syncLocalVolume, 500);
  }

  function setupGlobalInterception() {
    document.addEventListener("click", onDirectPlay, true);
    document.addEventListener("dblclick", onDirectPlay, true);

    document.addEventListener(
      "click",
      (event) => {
        const target = event.target && event.target.closest ? event.target : null;
        if (!target) return;

        const playPause = target.closest('[data-testid="control-button-playpause"]');
        if (playPause) {
          if (state.playerMode !== "local") return;
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          toggleLocal();
          return;
        }

        const next = target.closest('[data-testid="control-button-skip-forward"]');
        if (!next) return;

        if (state.playerMode === "local") {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
          playNextLocalOrAdvance();
          return;
        }

        if (playUpcomingLocal(null, { reason: "skip" })) {
          event.preventDefault();
          event.stopPropagation();
          event.stopImmediatePropagation();
        }
      },
      true,
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (state.playerMode !== "local") return;
        if (event.code !== "Space" || event.repeat) return;
        const active = document.activeElement;
        const tag = active && active.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (active && active.isContentEditable)) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        toggleLocal();
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Playlist scanning                                                  */
  /* ------------------------------------------------------------------ */

  function extractItems(response) {
    if (!response) return [];
    if (Array.isArray(response)) return response;
    if (Array.isArray(response.items)) return response.items;
    if (response.contents && Array.isArray(response.contents.items)) return response.contents.items;
    if (response.contents && Array.isArray(response.contents)) return response.contents;
    if (Array.isArray(response.rows)) return response.rows;
    return [];
  }

  async function fetchPlaylistRowsFallback(uri) {
    const id = playlistIdFromUri(uri);
    if (!id || !Spicetify.CosmosAsync) throw new Error("Playlist API is unavailable");
    const data = await Spicetify.CosmosAsync.get(`sp://core-playlist/v1/playlist/${id}/rows`, {
      policy: {
        link: true,
        name: true,
        artist: true,
        album: true,
        playable: true,
        isLocal: true,
        length: true,
        image: true,
      },
    });
    return extractItems(data);
  }

  async function fetchPlaylistTracks(uri) {
    if (uri === "spotify:collection:tracks") {
      if (!Spicetify.Platform || !Spicetify.Platform.LibraryAPI) {
        throw new Error("Liked Songs API is unavailable");
      }
      const response = await Spicetify.Platform.LibraryAPI.getTracks({ limit: 9999999 });
      return extractItems(response)
        .map(extractTrackInfo)
        .filter((track) => track.uri);
    }

    if (!Spicetify.Platform || !Spicetify.Platform.PlaylistAPI) {
      throw new Error("Playlist API is unavailable");
    }

    let response;
    try {
      response = await Spicetify.Platform.PlaylistAPI.getContents(uri, { limit: 9999999 });
    } catch (error) {
      response = await fetchPlaylistRowsFallback(uri);
    }

    let items = extractItems(response);
    const total = response && (response.totalLength || response.total || response.length);
    if (Number.isFinite(total) && total > items.length) {
      let offset = items.length;
      while (items.length < total) {
        try {
          const page = await Spicetify.Platform.PlaylistAPI.getContents(uri, {
            offset,
            limit: Math.min(1000, total - offset),
          });
          const pageItems = extractItems(page);
          if (!pageItems.length) break;
          items = items.concat(pageItems);
          offset = items.length;
        } catch (error) {
          break;
        }
      }
    }

    if (!items.length) {
      items = await fetchPlaylistRowsFallback(uri).catch(() => []);
    }

    return items.map(extractTrackInfo).filter((track) => track.uri);
  }

  async function fetchPlaylistName(uri) {
    if (uri === "spotify:collection:tracks") return "Liked Songs";
    const id = playlistIdFromUri(uri);
    if (!id) return "Playlist";

    try {
      if (
        Spicetify.Platform &&
        Spicetify.Platform.PlaylistAPI &&
        Spicetify.Platform.PlaylistAPI.getMetadata
      ) {
        const metadata = await Spicetify.Platform.PlaylistAPI.getMetadata(uri);
        if (metadata && metadata.name) return metadata.name;
      }
    } catch (error) {
      /* ignore */
    }

    try {
      if (Spicetify.CosmosAsync) {
        const data = await Spicetify.CosmosAsync.get(`sp://core-playlist/v1/playlist/${id}/metadata`);
        if (data && data.name) return data.name;
      }
    } catch (error) {
      /* ignore */
    }

    const context = getPlaylistContext();
    if (context && context.uri === uri) {
      const heading = document.querySelector(
        '[data-testid="playlist-page"] h1, .main-entityHeader-title h1',
      );
      if (heading && heading.textContent) return heading.textContent.trim();
    }

    return "Playlist";
  }

  async function applyAvailabilityFromItems(items) {
    if (!Array.isArray(items) || !items.length) return 0;
    let changed = 0;
    for (const item of items) {
      if (!item || !item.uri || typeof item.isUnavailable !== "boolean") continue;
      const mapping = getMapping(item.uri);
      if (!mapping || mapping.isUnavailable === item.isUnavailable) continue;
      mapping.isUnavailable = item.isUnavailable;
      mapping.updatedAt = Date.now();
      try {
        await idbPut(STORE_META, mapping);
        changed += 1;
      } catch (error) {
        console.warn("[LocalFill] Could not update track availability", error);
      }
    }
    if (changed) console.log(`[LocalFill] Updated availability for ${changed} mapping(s).`);
    return changed;
  }

  async function detectUnavailableInContext(uri, contextUri) {
    if (!contextUri || !isPlaylistUri(contextUri)) return null;
    let items = null;
    if (state.contextCache && state.contextCache.uri === contextUri) {
      items = state.contextCache.items;
    }
    if (!items) {
      items = await fetchPlaylistTracks(contextUri);
      state.contextCache = { uri: contextUri, items, fetchedAt: Date.now() };
    }
    const item = items.find((track) => track.uri === uri);
    return item && typeof item.isUnavailable === "boolean" ? item.isUnavailable : null;
  }

  function reconcileContext(context) {
    const playlistContext = context || getPlaylistContext();
    if (!playlistContext || !playlistContext.uri) return Promise.resolve(false);
    if (
      state.contextCache &&
      state.contextCache.uri === playlistContext.uri &&
      Date.now() - state.contextCache.fetchedAt < 10 * 60 * 1000
    ) {
      return Promise.resolve(false);
    }
    if (reconcilePromise) return reconcilePromise;

    reconcilePromise = (async () => {
      const items = await fetchPlaylistTracks(playlistContext.uri);
      state.contextCache = {
        uri: playlistContext.uri,
        items,
        fetchedAt: Date.now(),
      };
      return (await applyAvailabilityFromItems(items)) > 0;
    })()
      .catch((error) => {
        console.warn("[LocalFill] Could not reconcile playlist availability", error);
        return false;
      })
      .finally(() => {
        reconcilePromise = null;
      });
    return reconcilePromise;
  }

  /* ------------------------------------------------------------------ */
  /* DOM and modal helpers                                              */
  /* ------------------------------------------------------------------ */

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function button(label, className, onClick) {
    const node = element("button", `localfill-button ${className || ""}`, label);
    node.type = "button";
    node.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      try {
        await onClick(event);
      } catch (error) {
        console.error("[LocalFill] Button action failed", error);
        notify(`LocalFill: ${error.message || error}`, true);
      }
    });
    return node;
  }

  function openModal(title, build, isLarge) {
    if (!Spicetify.PopupModal || !Spicetify.PopupModal.display) {
      notify("LocalFill could not open its window. Spicetify PopupModal is unavailable.", true);
      return;
    }
    try {
      Spicetify.PopupModal.display({
        title,
        content: build(),
        isLarge: isLarge !== false,
      });
    } catch (error) {
      console.error("[LocalFill] Could not open modal", error);
      notify(`LocalFill could not open its window: ${error.message || error}`, true);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Scanner UI                                                         */
  /* ------------------------------------------------------------------ */

  function openScanner(playlistUri) {
    let uri = playlistUri;
    if (!uri) {
      const context = getPlaylistContext();
      if (context) uri = context.uri;
    }
    if (!uri) {
      notify("Open a playlist or Liked Songs first.", true);
      return;
    }

    const ui = createScannerUi(uri);
    openModal("LocalFill - Unavailable Songs", () => ui.element, true);
    ui.load();
  }

  function createScannerUi(playlistUri) {
    const root = element("div", "localfill-modal");
    const summary = element("div", "localfill-summary", "Loading playlist...");
    const toolbar = element("div", "localfill-toolbar");
    const tableWrap = element("div", "localfill-table-wrap");
    const table = element("table", "localfill-table");
    const thead = element("thead");
    const headerRow = element("tr");
    for (const label of ["", "#", "Track", "Local file", "Actions"]) {
      headerRow.appendChild(element("th", "", label));
    }
    thead.appendChild(headerRow);
    const tbody = element("tbody");
    table.append(thead, tbody);
    tableWrap.appendChild(table);
    root.append(summary, toolbar, tableWrap);

    const view = {
      playlistUri,
      items: [],
      unavailable: [],
      mapped: new Map(),
      suggestions: new Map(),
      selected: new Set(),
      candidates: [],
      name: "Playlist",
      loading: true,
      error: null,
    };

    const chooseFolderButton = button("Choose folder...", "localfill-button-secondary", async () => {
      const files = await pickFolderFiles();
      if (!files.length) return;
      view.candidates = files.filter(
        (file) => isAudioFileName(file.name) || (file.type && file.type.startsWith("audio/")),
      );
      if (!view.candidates.length) {
        notify("No supported audio files were found in that folder.", true);
        return;
      }
      recomputeSuggestions();
      notify(`Matched ${view.suggestions.size} track(s) from ${view.candidates.length} audio file(s).`);
      render();
    });
    chooseFolderButton.title = "Pick a folder and fuzzy-match audio files to unavailable tracks";

    const applySelectedButton = button("Apply selected", "", async () => {
      await applySuggestions(Array.from(view.selected));
    });

    const applyAllButton = button("Apply all suggestions", "localfill-button-secondary", async () => {
      await applySuggestions(Array.from(view.suggestions.keys()));
    });

    const clearButton = button("Clear playlist replacements", "localfill-button-danger", async () => {
      const mappedItems = view.unavailable.filter((item) => getMapping(item.uri));
      if (!mappedItems.length) {
        notify("This playlist has no LocalFill replacements to clear.");
        return;
      }
      const confirmed = window.confirm(
        `Remove LocalFill replacements for ${mappedItems.length} track(s) in this playlist?`,
      );
      if (!confirmed) return;
      for (const item of mappedItems) {
        await removeMapping(item.uri, { silent: true });
      }
      notify(`Cleared ${mappedItems.length} replacement(s) from this playlist.`);
      refreshMapped();
      recomputeSuggestions();
      render();
    });

    const refreshButton = button("Refresh", "localfill-button-secondary", async () => {
      await load();
    });

    toolbar.append(chooseFolderButton, applySelectedButton, applyAllButton, clearButton, refreshButton);

    function refreshMapped() {
      view.mapped = new Map();
      for (const item of view.unavailable) {
        const mapping = getMapping(item.uri);
        if (mapping) view.mapped.set(item.uri, mapping);
      }
    }

    function recomputeSuggestions() {
      if (!view.candidates.length) {
        view.suggestions = new Map();
        view.selected = new Set();
        return;
      }
      const candidatesToMatch = view.unavailable.filter((item) => !view.mapped.has(item.uri));
      view.suggestions = matchTracksToFiles(
        candidatesToMatch,
        view.candidates,
        state.settings.matchThreshold,
      );
      view.selected = new Set(view.suggestions.keys());
    }

    async function applySuggestions(uris) {
      const unique = Array.from(new Set(uris)).filter(
        (uri) => !getMapping(uri) && view.suggestions.has(uri),
      );
      if (!unique.length) {
        notify("No selected tracks have a suggested audio file.");
        return;
      }
      let applied = 0;
      for (const uri of unique) {
        const suggestion = view.suggestions.get(uri);
        const item = view.unavailable.find((track) => track.uri === uri);
        if (!suggestion || !item) continue;
        try {
          await saveMapping(uri, suggestion.file, item);
          applied += 1;
        } catch (error) {
          console.error("[LocalFill] Could not save suggested file", error);
        }
      }
      notify(`Stored ${applied} local replacement(s).`);
      refreshMapped();
      recomputeSuggestions();
      render();
    }

    async function chooseForRow(item) {
      const file = await pickAudioFile();
      if (!file) return;
      if (!isAudioFileName(file.name) && !(file.type && file.type.startsWith("audio/"))) {
        notify("The selected file is not a supported audio file.", true);
        return;
      }
      try {
        await saveMapping(item.uri, file, item);
        notify(`Mapped "${item.title}" to ${file.name}.`);
        refreshMapped();
        recomputeSuggestions();
        render();
      } catch (error) {
        notify(`Could not save the local file: ${error.message || error}`, true);
      }
    }

    function trackCell(item) {
      const container = element("div", "localfill-track-cell");
      container.appendChild(element("div", "localfill-track-title", item.title || "Unknown track"));
      container.appendChild(
        element("div", "localfill-muted", item.artists.join(", ") || "Unknown artist"),
      );
      if (item.album) container.appendChild(element("div", "localfill-muted", item.album));
      return container;
    }

    function fileCell(item) {
      const container = element("div", "localfill-file-cell");
      const mapping = view.mapped.get(item.uri);
      if (mapping) {
        container.appendChild(element("div", "localfill-status", mapping.fileName));
        container.appendChild(element("div", "localfill-muted", formatBytes(mapping.fileSize)));
        return container;
      }
      const suggestion = view.suggestions.get(item.uri);
      if (suggestion) {
        container.appendChild(
          element(
            "div",
            "localfill-suggestion",
            `Suggested: ${suggestion.file.name} (${Math.round(suggestion.score * 100)}%)`,
          ),
        );
        container.appendChild(
          button("Use", "localfill-button-small", async () => {
            await applySuggestions([item.uri]);
          }),
        );
      } else {
        container.appendChild(element("div", "localfill-muted", "No match. Choose a file."));
      }
      return container;
    }

    function actionsCell(item) {
      const container = element("div", "localfill-row-actions");
      const mapping = view.mapped.get(item.uri);
      container.appendChild(
        button(
          mapping ? "Replace file..." : "Choose file...",
          "localfill-button-small localfill-button-secondary",
          async () => {
            await chooseForRow(item);
          },
        ),
      );
      if (mapping) {
        container.appendChild(
          button("Play", "localfill-button-small", async () => {
            await playLocalNow(item.uri);
          }),
        );
        container.appendChild(
          button("Remove", "localfill-button-small localfill-button-danger", async () => {
            await removeMapping(item.uri, { silent: true });
            notify(`Removed local file for "${item.title}".`);
            refreshMapped();
            recomputeSuggestions();
            render();
          }),
        );
      }
      return container;
    }

    function render() {
      if (view.loading) {
        summary.textContent = "Loading playlist...";
      } else if (view.error) {
        summary.textContent = `Could not load this playlist: ${view.error}`;
      } else {
        const mappedCount = view.mapped.size;
        summary.textContent = `${view.unavailable.length} unavailable track(s) in "${view.name}". ${mappedCount} replacement(s) stored.`;
      }

      const selectable = new Set(
        Array.from(view.suggestions.keys()).filter((uri) => !view.mapped.has(uri)),
      );
      applySelectedButton.textContent = `Apply selected (${Array.from(view.selected).filter((uri) => selectable.has(uri)).length})`;
      applySelectedButton.disabled = !Array.from(view.selected).some((uri) => selectable.has(uri));
      applyAllButton.disabled = view.suggestions.size === 0;
      clearButton.disabled = view.mapped.size === 0;

      tbody.replaceChildren();

      if (view.loading) {
        const row = element("tr");
        const cell = element("td", "localfill-empty", "Loading...");
        cell.colSpan = 5;
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
      }

      if (view.error) {
        const row = element("tr");
        const cell = element("td", "localfill-empty", view.error);
        cell.colSpan = 5;
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
      }

      if (!view.unavailable.length) {
        const row = element("tr");
        const cell = element("td", "localfill-empty", "No unavailable tracks found in this playlist.");
        cell.colSpan = 5;
        row.appendChild(cell);
        tbody.appendChild(row);
        return;
      }

      for (const item of view.unavailable) {
        const row = element("tr");
        const index = view.items.indexOf(item) + 1;

        const checkCell = element("td", "localfill-check-cell");
        const checkbox = document.createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = view.selected.has(item.uri);
        checkbox.disabled = !!view.mapped.get(item.uri) || !view.suggestions.has(item.uri);
        checkbox.addEventListener("change", () => {
          if (checkbox.checked) view.selected.add(item.uri);
          else view.selected.delete(item.uri);
          render();
        });
        checkCell.appendChild(checkbox);
        row.appendChild(checkCell);

        row.appendChild(element("td", "localfill-index", String(index)));
        row.appendChild(trackCell(item));

        const localCell = element("td");
        localCell.appendChild(fileCell(item));
        row.appendChild(localCell);

        const actionCell = element("td");
        actionCell.appendChild(actionsCell(item));
        row.appendChild(actionCell);

        tbody.appendChild(row);
      }
    }

    async function load() {
      view.loading = true;
      view.error = null;
      render();
      try {
        const result = await Promise.all([
          fetchPlaylistTracks(playlistUri),
          fetchPlaylistName(playlistUri),
        ]);
        view.items = result[0];
        view.name = result[1] || "Playlist";
        view.unavailable = view.items.filter((item) => item.isUnavailable);
        state.contextCache = {
          uri: playlistUri,
          items: view.items,
          fetchedAt: Date.now(),
        };
        await applyAvailabilityFromItems(view.items);
        refreshMapped();
        recomputeSuggestions();
        view.loading = false;
      } catch (error) {
        console.error("[LocalFill] Could not scan playlist", error);
        view.error = error.message || String(error);
        view.loading = false;
      }
      render();
    }

    render();
    return { element: root, load };
  }

  /* ------------------------------------------------------------------ */
  /* Settings UI                                                        */
  /* ------------------------------------------------------------------ */

  function openSettings() {
    const ui = createSettingsUi();
    openModal("LocalFill", () => ui.element, true);
    ui.refresh();
  }

  function createSettingsUi() {
    const root = element("div", "localfill-modal localfill-settings");
    const stats = element("div", "localfill-card localfill-stats", "Loading storage...");
    const settingsCard = element("div", "localfill-card");
    const settingsTitle = element("h3", "localfill-card-title", "Playback");
    settingsCard.appendChild(settingsTitle);

    function addToggle(key, label, description) {
      const wrapper = element("label", "localfill-toggle");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.checked = !!state.settings[key];
      input.addEventListener("change", () => {
        state.settings[key] = input.checked;
        saveSettings();
        if (key === "showPill") {
          setPillVisible(!!state.local);
        }
        if (key === "syncVolume") {
          if (!input.checked && audio) {
            state.settings.localVolume = clamp(audio.volume, 0, 1);
            saveSettings();
          }
          syncLocalVolume();
          updatePill();
        }
      });
      const text = element("span", "localfill-toggle-text");
      text.appendChild(element("span", "localfill-toggle-label", label));
      text.appendChild(element("span", "localfill-muted", description));
      wrapper.append(input, text);
      settingsCard.appendChild(wrapper);
    }

    addToggle(
      "autoPlay",
      "Start replacements automatically",
      "Pause Spotify and play the local file when a mapped track is reached.",
    );
    addToggle(
      "showPill",
      "Show the LocalFill player",
      "Display floating progress and playback controls while a local file is active.",
    );
    addToggle(
      "overridePlayable",
      "Override playable tracks",
      "Use the local file even when Spotify says the track is available.",
    );
    addToggle(
      "syncVolume",
      "Follow Spotify volume",
      "Keep the local file at Spotify's volume. Moving the LocalFill volume slider turns this off.",
    );

    const actions = element("div", "localfill-toolbar");
    const scanButton = button("Scan current playlist", "", async () => {
      const context = getPlaylistContext();
      if (!context) {
        notify("Open a playlist or Liked Songs first.", true);
        return;
      }
      openScanner(context.uri);
    });
    scanButton.disabled = !getPlaylistContext();

    const clearButton = button("Clear all replacements", "localfill-button-danger", async () => {
      const count = state.mapIndex.size;
      if (!count) {
        notify("There are no LocalFill replacements to clear.");
        return;
      }
      if (!window.confirm(`Remove all ${count} LocalFill replacement(s)? This cannot be undone.`)) {
        return;
      }
      await clearAllMappings();
      await refresh();
    });

    const diagnosticsButton = button("Copy diagnostics", "localfill-button-secondary", async () => {
      await copyDiagnostics();
    });

    actions.append(scanButton, clearButton, diagnosticsButton);
    settingsCard.appendChild(actions);

    const mappingCard = element("div", "localfill-card");
    const mappingTitle = element("h3", "localfill-card-title", "Stored replacements");
    const mappingList = element("div", "localfill-mapping-list");
    mappingCard.append(mappingTitle, mappingList);

    const footer = element("div", "localfill-footer");
    footer.appendChild(
      element(
        "p",
        "localfill-muted",
        "LocalFill stores audio in Spotify's app storage. Discord Rich Presence is planned for a future version.",
      ),
    );
    const repo = document.createElement("a");
    repo.href = "https://github.com/Redesu/spicetify-localfill";
    repo.target = "_blank";
    repo.rel = "noreferrer";
    repo.textContent = "github.com/Redesu/spicetify-localfill";
    footer.appendChild(repo);

    root.append(stats, settingsCard, mappingCard, footer);

    async function refresh() {
      const count = state.mapIndex.size;
      let storage = "Unavailable";
      try {
        if (navigator.storage && navigator.storage.estimate) {
          const estimate = await navigator.storage.estimate();
          storage = `${formatBytes(estimate.usage || 0)} used of ${formatBytes(estimate.quota || 0)}`;
        }
      } catch (error) {
        /* ignore */
      }
      stats.textContent = `${count} replacement(s) stored. Browser storage: ${storage}.`;

      mappingList.replaceChildren();
      const mappings = Array.from(state.mapIndex.values()).sort(
        (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      );
      if (!mappings.length) {
        mappingList.appendChild(element("div", "localfill-muted", "No replacements stored yet."));
        return;
      }

      for (const mapping of mappings.slice(0, 300)) {
        const row = element("div", "localfill-mapping-row");
        if (mapping.albumArt) {
          const image = document.createElement("img");
          image.className = "localfill-mapping-art";
          image.src = mapping.albumArt;
          image.alt = "";
          row.appendChild(image);
        } else {
          row.appendChild(element("div", "localfill-mapping-art localfill-mapping-art-empty"));
        }

        const info = element("div", "localfill-mapping-info");
        info.appendChild(element("div", "localfill-track-title", mapping.title || "Unknown track"));
        info.appendChild(
          element("div", "localfill-muted", (mapping.artists || []).join(", ") || "Unknown artist"),
        );
        info.appendChild(
          element(
            "div",
            "localfill-muted",
            `${mapping.fileName || "Stored file"} - ${formatBytes(
              mapping.fileSize,
            )}${mapping.isUnavailable ? "" : " - playable override"}`,
          ),
        );
        row.appendChild(info);

        const rowActions = element("div", "localfill-row-actions");
        rowActions.appendChild(
          button("Play", "localfill-button-small", async () => {
            await playLocalNow(mapping.uri);
          }),
        );
        rowActions.appendChild(
          button("Remove", "localfill-button-small localfill-button-danger", async () => {
            await removeMapping(mapping.uri, { silent: true });
            notify(`Removed local file for "${mapping.title}".`);
            await refresh();
          }),
        );
        row.appendChild(rowActions);
        mappingList.appendChild(row);
      }

      if (mappings.length > 300) {
        mappingList.appendChild(
          element(
            "div",
            "localfill-muted",
            `Showing the 300 most recent replacements out of ${mappings.length}.`,
          ),
        );
      }
    }

    return { element: root, refresh };
  }

  function buildDiagnostics() {
    let data = null;
    try {
      data = Spicetify.Player && Spicetify.Player.data;
    } catch (error) {
      /* ignore */
    }
    return {
      extension: "LocalFill",
      version: "1.0.0",
      spicetify: (Spicetify.Config && Spicetify.Config.version) || "unknown",
      location:
        (Spicetify.Platform &&
          Spicetify.Platform.History &&
          Spicetify.Platform.History.location &&
          Spicetify.Platform.History.location.pathname) ||
        window.location.pathname,
      current: {
        uri: data && data.item && data.item.uri,
        context: data && data.context && data.context.uri,
        isPlaying: Spicetify.Player && Spicetify.Player.isPlaying && Spicetify.Player.isPlaying(),
        progress: Spicetify.Player && Spicetify.Player.getProgress && Spicetify.Player.getProgress(),
        duration: Spicetify.Player && Spicetify.Player.getDuration && Spicetify.Player.getDuration(),
      },
      nextItems: ((data && data.nextItems) || []).map((item) => item.uri).slice(0, 30),
      nextTracks: ((Spicetify.Queue && Spicetify.Queue.nextTracks) || [])
        .map((item) => item.uri || (item.contextTrack && item.contextTrack.uri))
        .slice(0, 30),
      settings: { ...state.settings },
      mappings: Array.from(state.mapIndex.values()).map((mapping) => ({
        uri: mapping.uri,
        title: mapping.title,
        isUnavailable: mapping.isUnavailable,
        fileName: mapping.fileName,
        fileSize: mapping.fileSize,
      })),
      local: state.local
        ? {
            uri: state.local.uri,
            paused: audio && audio.paused,
            currentTime: audio && audio.currentTime,
            duration: audio && audio.duration,
          }
        : null,
      playerMode: state.playerMode,
    };
  }

  async function copyDiagnostics() {
    const text = JSON.stringify(buildDiagnostics(), null, 2);
    console.log("[LocalFill] diagnostics\n" + text);
    try {
      if (Spicetify.Platform && Spicetify.Platform.ClipboardAPI) {
        await Spicetify.Platform.ClipboardAPI.copy(text);
      } else if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        throw new Error("Clipboard is unavailable");
      }
      notify("LocalFill diagnostics copied to the clipboard.");
    } catch (error) {
      notify("LocalFill diagnostics were written to the developer console.");
    }
  }

  /* ------------------------------------------------------------------ */
  /* Menus and commands                                                 */
  /* ------------------------------------------------------------------ */

  async function chooseLocalFile(uri, contextUri) {
    if (!isTrackUri(uri)) return;
    const file = await pickAudioFile();
    if (!file) return;
    if (!isAudioFileName(file.name) && !(file.type && file.type.startsWith("audio/"))) {
      notify("The selected file is not a supported audio file.", true);
      return;
    }

    try {
      const info = await fetchTrackInfo(uri);
      try {
        const unavailable = await detectUnavailableInContext(uri, contextUri);
        if (typeof unavailable === "boolean") info.isUnavailable = unavailable;
      } catch (error) {
        console.warn("[LocalFill] Could not verify availability in this playlist", error);
      }
      const meta = await saveMapping(uri, file, info);
      notify(`LocalFill: mapped "${meta.title}".`);
      if (getCurrentUri() === uri) {
        await playLocalNow(uri);
      } else if (!meta.isUnavailable && !state.settings.overridePlayable) {
        notify(
          "This track is playable on Spotify. Enable 'Override playable tracks' in LocalFill settings to use the local file.",
        );
      }
    } catch (error) {
      notify(`Could not save the local file: ${error.message || error}`, true);
    }
  }

  async function removeLocalFile(uri) {
    if (!isTrackUri(uri)) return;
    await removeMapping(uri);
  }

  function setupContextMenus() {
    if (!Spicetify.ContextMenu) return;

    const chooseItem = new Spicetify.ContextMenu.Item(
      "Choose local audio file...",
      (uris, uids, contextUri) => chooseLocalFile(uris[0], contextUri),
      (uris) => uris.length === 1 && isTrackUri(uris[0]),
      "download",
    );
    const playItem = new Spicetify.ContextMenu.Item(
      "Play local replacement now",
      (uris) => playLocalNow(uris[0]),
      (uris) => uris.length === 1 && isTrackUri(uris[0]) && !!getMapping(uris[0]),
      "play",
    );
    const removeItem = new Spicetify.ContextMenu.Item(
      "Remove local replacement",
      (uris) => removeLocalFile(uris[0]),
      (uris) => uris.length === 1 && isTrackUri(uris[0]) && !!getMapping(uris[0]),
      "delete",
    );

    if (Spicetify.ContextMenu.SubMenu) {
      const submenu = new Spicetify.ContextMenu.SubMenu(
        "LocalFill",
        [chooseItem, playItem, removeItem],
        (uris) => uris.length === 1 && isTrackUri(uris[0]),
      );
      submenu.register();
    } else {
      const fallbackItem = new Spicetify.ContextMenu.Item(
        "LocalFill: Choose local audio file...",
        (uris, uids, contextUri) => chooseLocalFile(uris[0], contextUri),
        (uris) => uris.length === 1 && isTrackUri(uris[0]),
        "download",
      );
      fallbackItem.register();
    }

    const scanItem = new Spicetify.ContextMenu.Item(
      "LocalFill: Find unavailable songs",
      (uris) => openScanner(uris[0]),
      (uris) => uris.length === 1 && isPlaylistUri(uris[0]),
      "search",
    );
    scanItem.register();
  }

  function setupTopbar() {
    const icon =
      '<svg role="img" height="16" width="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1.75 4.25A1.75 1.75 0 0 1 3.5 2.5h2.55c.46 0 .9.18 1.23.5l1.07 1.04c.14.14.33.21.53.21h3.62a1.75 1.75 0 0 1 1.75 1.75v6a1.75 1.75 0 0 1-1.75 1.75h-9a1.75 1.75 0 0 1-1.75-1.75v-7.75z"/><path d="M6.6 6.8v3.2l2.65-1.6-2.65-1.6z" fill="currentColor" stroke="none"/></svg>';

    const mount = () => {
      const right = document.querySelector(".main-topBar-topbarContentRight");
      if (!right) return false;
      if (right.querySelector(".localfill-topbar-button")) return true;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "localfill-topbar-button";
      button.title = "LocalFill";
      button.setAttribute("aria-label", "LocalFill");
      button.innerHTML = icon;
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const context = getPlaylistContext();
        if (context) openScanner(context.uri);
        else openSettings();
      });
      right.insertBefore(button, right.firstChild);
      return true;
    };

    if (mount()) return true;

    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (mount() || attempts > 120) clearInterval(timer);
    }, 500);
    return "scheduled";
  }

  function setupMenu() {
    if (!Spicetify.Menu || !Spicetify.Menu.Item) return;
    const item = new Spicetify.Menu.Item("LocalFill", false, () => openSettings());
    item.register();
  }

  /* ------------------------------------------------------------------ */
  /* Styles                                                             */
  /* ------------------------------------------------------------------ */

  function injectStyles() {
    if (document.getElementById("localfill-styles")) return;
    const style = document.createElement("style");
    style.id = "localfill-styles";
    style.textContent = `
      .localfill-pill {
        position: fixed;
        right: 24px;
        bottom: 96px;
        z-index: 999999;
        display: none;
        flex-direction: column;
        gap: 8px;
        width: 360px;
        max-width: calc(100vw - 32px);
        padding: 12px;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 14px;
        background: var(--spice-card, #282828);
        color: var(--spice-text, #fff);
        box-shadow: 0 12px 36px rgba(0, 0, 0, 0.45);
        font-family: var(--font-family, inherit);
      }
      .localfill-pill.is-visible { display: flex; }
      .localfill-pill-main { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .localfill-pill-art {
        width: 48px;
        height: 48px;
        flex: 0 0 48px;
        border-radius: 8px;
        object-fit: cover;
        background: rgba(255, 255, 255, 0.08);
      }
      .localfill-pill-text { min-width: 0; flex: 1 1 auto; }
      .localfill-pill-title {
        overflow: hidden;
        font-size: 14px;
        font-weight: 700;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .localfill-pill-artist {
        overflow: hidden;
        margin-top: 2px;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 12px;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .localfill-pill-buttons { display: flex; align-items: center; gap: 4px; }
      .localfill-icon-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--spice-text, #fff);
        cursor: pointer;
      }
      .localfill-icon-button:hover { background: rgba(255, 255, 255, 0.1); }
      .localfill-icon-button svg { width: 14px; height: 14px; }
      .localfill-topbar-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 32px;
        height: 32px;
        margin: 0 4px;
        padding: 0;
        border: 0;
        border-radius: 50%;
        background: transparent;
        color: var(--spice-text, #fff);
        cursor: pointer;
      }
      .localfill-topbar-button:hover { background: rgba(255, 255, 255, 0.1); }
      .localfill-topbar-button svg { width: 16px; height: 16px; }
      .localfill-pill-progress { display: flex; align-items: center; gap: 8px; }
      .localfill-pill-current,
      .localfill-pill-duration {
        width: 34px;
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px;
        font-variant-numeric: tabular-nums;
      }
      .localfill-pill-duration { text-align: right; }
      .localfill-pill-seek { flex: 1 1 auto; min-width: 0; accent-color: var(--spice-button, #1ed760); }
      .localfill-pill-volume { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; }
      .localfill-pill-volume-icon { display: inline-flex; color: var(--spice-subtext, #b3b3b3); }
      .localfill-pill-volume-icon svg { width: 13px; height: 13px; }
      .localfill-pill-volume-slider {
        width: 58px;
        accent-color: var(--spice-button, #1ed760);
      }
      .localfill-row-indicator {
        display: inline-flex;
        align-items: center;
        flex: 0 0 auto;
        margin-right: 6px;
        padding: 1px 6px;
        border-radius: 999px;
        background: var(--spice-button, #1ed760);
        color: var(--spice-button-text, #000);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.06em;
        line-height: 1.5;
        text-transform: uppercase;
        pointer-events: none;
      }
      .localfill-row-indicator::before {
        content: "";
        width: 4px;
        height: 4px;
        margin-right: 4px;
        border-radius: 50%;
        background: currentColor;
      }
      .localfill-pill-badge {
        align-self: flex-start;
        padding: 2px 6px;
        border-radius: 4px;
        background: var(--spice-button, #1ed760);
        color: var(--spice-button-text, #000);
        font-size: 9px;
        font-weight: 800;
        letter-spacing: 0.08em;
      }
      .localfill-modal-host { width: 100%; }
      .localfill-modal {
        display: flex;
        flex-direction: column;
        gap: 12px;
        width: 100%;
        color: var(--spice-text, #fff);
        font-size: 14px;
      }
      .localfill-summary { color: var(--spice-subtext, #b3b3b3); }
      .localfill-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .localfill-button {
        padding: 8px 14px;
        border: 0;
        border-radius: 999px;
        background: var(--spice-button, #1ed760);
        color: var(--spice-button-text, #000);
        font-weight: 700;
        cursor: pointer;
      }
      .localfill-button:hover { filter: brightness(1.08); }
      .localfill-button:disabled { cursor: default; opacity: 0.4; filter: none; }
      .localfill-button-secondary {
        background: rgba(255, 255, 255, 0.12);
        color: var(--spice-text, #fff);
      }
      .localfill-button-danger { background: rgba(255, 85, 85, 0.9); color: #fff; }
      .localfill-button-small { padding: 4px 9px; font-size: 11px; }
      .localfill-table-wrap {
        max-height: 54vh;
        overflow: auto;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 8px;
      }
      .localfill-table { width: 100%; border-collapse: collapse; font-size: 13px; }
      .localfill-table th,
      .localfill-table td {
        padding: 8px 6px;
        border-bottom: 1px solid rgba(255, 255, 255, 0.07);
        text-align: left;
        vertical-align: top;
      }
      .localfill-table th {
        position: sticky;
        top: 0;
        z-index: 1;
        background: var(--spice-card, #282828);
        color: var(--spice-subtext, #b3b3b3);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
      }
      .localfill-table tr:last-child td { border-bottom: 0; }
      .localfill-track-cell { min-width: 180px; }
      .localfill-track-title { font-weight: 700; }
      .localfill-muted { color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
      .localfill-status { color: var(--spice-button, #1ed760); font-weight: 600; }
      .localfill-suggestion { margin-bottom: 4px; color: #9bd6ff; font-weight: 600; }
      .localfill-file-cell { min-width: 190px; }
      .localfill-row-actions { display: flex; flex-wrap: wrap; gap: 4px; }
      .localfill-check-cell { width: 28px; }
      .localfill-index {
        width: 40px;
        color: var(--spice-subtext, #b3b3b3);
        font-variant-numeric: tabular-nums;
      }
      .localfill-empty { padding: 22px; text-align: center; color: var(--spice-subtext, #b3b3b3); }
      .localfill-card {
        display: flex;
        flex-direction: column;
        gap: 10px;
        padding: 14px;
        border: 1px solid rgba(255, 255, 255, 0.08);
        border-radius: 10px;
        background: rgba(255, 255, 255, 0.035);
      }
      .localfill-card-title { margin: 0; font-size: 15px; }
      .localfill-stats { color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
      .localfill-toggle {
        display: flex;
        align-items: flex-start;
        gap: 10px;
        cursor: pointer;
      }
      .localfill-toggle input { margin-top: 3px; accent-color: var(--spice-button, #1ed760); }
      .localfill-toggle-text { display: flex; flex-direction: column; gap: 2px; }
      .localfill-toggle-label { font-weight: 600; }
      .localfill-mapping-list { display: flex; flex-direction: column; gap: 8px; max-height: 32vh; overflow: auto; }
      .localfill-mapping-row { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .localfill-mapping-art {
        width: 36px;
        height: 36px;
        flex: 0 0 36px;
        border-radius: 6px;
        object-fit: cover;
        background: rgba(255, 255, 255, 0.08);
      }
      .localfill-mapping-art-empty { display: block; }
      .localfill-mapping-info { flex: 1 1 auto; min-width: 0; }
      .localfill-footer { display: flex; flex-direction: column; gap: 4px; color: var(--spice-subtext, #b3b3b3); font-size: 12px; }
      .localfill-footer p { margin: 0; }
      .localfill-footer a { color: var(--spice-button, #1ed760); }
    `;
    document.head.appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* Bootstrap                                                          */
  /* ------------------------------------------------------------------ */

  function sleep(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function recordInitStatus(status) {
    try {
      window.localStorage.setItem("localfill:init", JSON.stringify(status));
    } catch (error) {
      /* ignore */
    }
  }

  async function waitForSpicetify() {
    for (let attempt = 0; attempt < 240; attempt += 1) {
      if (
        typeof Spicetify !== "undefined" &&
        Spicetify.Player &&
        Spicetify.Platform &&
        Spicetify.ContextMenu
      ) {
        return;
      }
      await sleep(100);
    }
    throw new Error("Timed out waiting for Spicetify APIs");
  }

  async function main() {
    await waitForSpicetify();

    document.querySelectorAll(".localfill-pill, #localfill-styles").forEach((node) => node.remove());
    injectStyles();
    setupAudio();
    await loadPersistedSettings();

    try {
      await openDb();
      await loadMappings();
    } catch (error) {
      console.error("[LocalFill] Storage initialization failed", error);
      notify("LocalFill storage is unavailable. Files cannot be saved.", true);
    }

    const setups = [
      setupContextMenus,
      setupTopbar,
      setupMenu,
      setupPlayerListeners,
      setupGlobalInterception,
      setupRowIndicators,
    ];
    const setupStatus = {};
    for (const setup of setups) {
      try {
        setupStatus[setup.name] = setup();
      } catch (error) {
        setupStatus[setup.name] = `error: ${error.message || error}`;
        console.warn(`[LocalFill] ${setup.name} failed`, error);
      }
    }

    recordInitStatus({
      at: Date.now(),
      version: "1.0.0",
      mappings: state.mapIndex.size,
      autoPlay: state.settings.autoPlay,
      topbarApi: !!(Spicetify.Topbar && Spicetify.Topbar.Button),
      menuApi: !!(Spicetify.Menu && Spicetify.Menu.Item),
      contextMenuApi: !!Spicetify.ContextMenu,
      setupStatus,
    });

    reconcileContext();

    console.log(
      `[LocalFill] ready (${state.mapIndex.size} replacement(s), ${state.settings.autoPlay ? "auto" : "manual"} mode)`,
    );
  }

  main().catch((error) => {
    console.error("[LocalFill] Failed to initialize", error);
    try {
      if (Spicetify.showNotification) {
        Spicetify.showNotification("LocalFill failed to start. See the developer console.", true);
      }
    } catch (notificationError) {
      /* ignore */
    }
  });
})();
