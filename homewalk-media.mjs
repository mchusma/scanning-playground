/** Offset the audio input onto the video's Unix timeline. Positive means the
 * microphone began later and needs leading silence; negative trims early audio. */
export function audioInputOffset(media) {
  const video = media.videoStartedAt, audio = media.audioStartedAt;
  return Number.isFinite(video) && Number.isFinite(audio) ? audio - video : 0;
}

export function audioInputTimingArguments(media) {
  const offset = audioInputOffset(media);
  // Explicitly seek early audio: a negative input timestamp can cause a muxer
  // to shift the entire movie, losing the saved video-start anchor.
  return offset < 0 ? ['-ss', String(-offset)] : ['-itsoffset', String(offset)];
}
