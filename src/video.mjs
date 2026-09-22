import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

const FFMPEG = process.env.AUTOQA_FFMPEG || '/opt/homebrew/bin/ffmpeg';
const FFPROBE = process.env.AUTOQA_FFPROBE || '/opt/homebrew/bin/ffprobe';

async function binary(preferred, fallback) {
  try {
    await access(preferred, constants.X_OK);
    return preferred;
  } catch {
    return fallback;
  }
}

export const ffmpegPath = () => binary(FFMPEG, 'ffmpeg');
export const ffprobePath = () => binary(FFPROBE, 'ffprobe');

/**
 * Convert the browser's raw webm capture to a widely playable mp4.
 * Captions and cards are painted in the page, so no text filters are needed
 * (this ffmpeg build ships without drawtext/subtitles).
 */
export async function toMp4(input, output) {
  const ffmpeg = await ffmpegPath();
  const args = ['-y', '-i', input,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-an', output];
  try {
    await run(ffmpeg, args, { maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    const detail = (error.stderr || error.message || '').split('\n').filter(Boolean).slice(-3).join(' | ');
    throw new Error(`ffmpeg failed to convert ${input}: ${detail}`);
  }
  return output;
}

/** Media duration in milliseconds, or null when it cannot be determined. */
export async function durationMs(file) {
  const ffprobe = await ffprobePath();
  try {
    const { stdout } = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1', file]);
    const seconds = Number.parseFloat(stdout.trim());
    return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
  } catch {
    return null;
  }
}
