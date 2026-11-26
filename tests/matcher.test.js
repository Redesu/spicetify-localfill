const test = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeText,
  normalizeFileName,
  diceCoefficient,
  scoreMatch,
  matchTracksToFiles,
  isAudioFileName,
  formatTime,
  formatBytes,
} = require("../extension.js");

test("normalizeText strips brackets, featuring credits, case, and accents", () => {
  assert.equal(
    normalizeText("Beyoncé - Halo (feat. Somebody) [Official Video]"),
    "beyonce halo",
  );
  assert.equal(normalizeText("  The   Artist  "), "the artist");
  assert.equal(normalizeText(""), "");
});

test("normalizeFileName strips extensions and leading track numbers", () => {
  assert.equal(normalizeFileName("01 - Slipknot - Wait and Bleed.mp3"), "slipknot wait and bleed");
  assert.equal(normalizeFileName("09. Artist - Title.flac"), "artist title");
  assert.equal(normalizeFileName("Song.m4a"), "song");
});

test("diceCoefficient behaves sensibly", () => {
  assert.equal(diceCoefficient("wait and bleed", "wait and bleed"), 1);
  assert.equal(diceCoefficient("wait and bleed", ""), 0);
  assert.ok(diceCoefficient("wait and bleed", "wait bleed") > 0.8);
  assert.ok(
    diceCoefficient("wait and bleed", "unrelated title") <
      diceCoefficient("wait and bleed", "wait bleed"),
  );
});

test("scoreMatch prefers artist/title filenames over unrelated files", () => {
  const track = {
    title: "Wait and Bleed",
    artists: ["Slipknot"],
    album: "Slipknot",
  };

  const good = scoreMatch(track, "09 - Slipknot - Wait and Bleed.mp3");
  const goodTitleOnly = scoreMatch(track, "Wait and Bleed.flac");
  const bad = scoreMatch(track, "Daft Punk - One More Time.mp3");

  assert.ok(good > 0.7, `expected ${good} > 0.7`);
  assert.ok(goodTitleOnly > 0.6, `expected ${goodTitleOnly} > 0.6`);
  assert.ok(bad < 0.4, `expected ${bad} < 0.4`);
});

test("matchTracksToFiles assigns the best candidate above the threshold", () => {
  const tracks = [
    { uri: "spotify:track:one", title: "Wait and Bleed", artists: ["Slipknot"] },
    { uri: "spotify:track:two", title: "One More Time", artists: ["Daft Punk"] },
    { uri: "spotify:track:three", title: "Nothing Matches This", artists: ["Nobody"] },
  ];
  const files = [
    { name: "01 - Slipknot - Wait and Bleed.mp3" },
    { name: "Daft Punk - One More Time.flac" },
    { name: "Some Other Song.ogg" },
  ];

  const matches = matchTracksToFiles(tracks, files, 0.5);
  assert.equal(matches.get("spotify:track:one").file.name, files[0].name);
  assert.equal(matches.get("spotify:track:two").file.name, files[1].name);
  assert.equal(matches.has("spotify:track:three"), false);
});

test("isAudioFileName recognizes supported audio extensions", () => {
  assert.equal(isAudioFileName("song.mp3"), true);
  assert.equal(isAudioFileName("song.FLAC"), true);
  assert.equal(isAudioFileName("song.m4a"), true);
  assert.equal(isAudioFileName("cover.jpg"), false);
  assert.equal(isAudioFileName("no-extension"), false);
});

test("formatting helpers", () => {
  assert.equal(formatTime(0), "0:00");
  assert.equal(formatTime(65), "1:05");
  assert.equal(formatTime(-1), "0:00");
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
});
