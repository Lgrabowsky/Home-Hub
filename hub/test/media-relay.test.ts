import { describe, expect, it } from 'vitest';
import { clientMessageProblem, sanitizeUpstreamText } from '../src/http/routes/realtime.ts';

/** What viewers may hand to the private video service, and what they get back from it. */

const OFFER = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', 'm=video 9 UDP/TLS/RTP/SAVPF 96 97', 'a=recvonly', 'a=rtpmap:96 H264/90000', 'a=rtpmap:97 rtx/90000', 'm=audio 9 UDP/TLS/RTP/SAVPF 111', 'a=rtpmap:111 opus/48000/2', ''].join('\r\n');

describe('messages from viewers', () => {
  it('lets a browser offer through', () => {
    expect(clientMessageProblem('webrtc/offer', OFFER, { candidates: 0 })).toBeNull();
  });

  it('refuses rtpmap lines that make go2rtc 1.9.15 panic', () => {
    for (const line of ['a=rtpmap:111', 'a=rtpmap:111 ', 'a=rtpmap:111 opus', 'a=rtpmap:111 opus/', 'a=rtpmap:x opus/48000']) {
      expect(clientMessageProblem('webrtc/offer', OFFER.replace('a=rtpmap:111 opus/48000/2', line), { candidates: 0 }), line).toBe('malformed rtpmap');
    }
  });

  it('refuses things that are not offers, and oversized ones', () => {
    expect(clientMessageProblem('webrtc/offer', 'this is not SDP', { candidates: 0 })).toBe('not an SDP offer');
    expect(clientMessageProblem('webrtc/offer', OFFER + 'a=x\r\n'.repeat(10_000), { candidates: 0 })).toBe('offer too large');
  });

  it('limits candidates in size, shape and number', () => {
    const state = { candidates: 0 };
    expect(clientMessageProblem('webrtc/candidate', 'candidate:1 1 udp 2122260223 192.168.1.5 50000 typ host', state)).toBeNull();
    expect(clientMessageProblem('webrtc/candidate', '', state)).toBeNull();
    expect(clientMessageProblem('webrtc/candidate', 'x'.repeat(100), state)).toBe('not a candidate');
    expect(clientMessageProblem('webrtc/candidate', `candidate:${'1'.repeat(600)}`, state)).toBe('candidate too large');
    const many = { candidates: 0 };
    for (let i = 0; i < 100; i++) expect(clientMessageProblem('webrtc/candidate', 'candidate:1', many)).toBeNull();
    expect(clientMessageProblem('webrtc/candidate', 'candidate:1', many)).toBe('too many candidates');
  });

  it('bounds the codec list of the fallback transport', () => {
    expect(clientMessageProblem('mse', 'avc1.640029,mp4a.40.2,opus', { candidates: 0 })).toBeNull();
    expect(clientMessageProblem('mse', 'a'.repeat(400), { candidates: 0 })).toBe('codec list too large');
  });
});

describe('messages from the video service', () => {
  it('never passes on error texts, which can contain camera credentials', () => {
    const leaked = JSON.stringify({ type: 'error', value: 'mse: streams: Get "https://192.168.1.60/flv?user=admin&password=S3cret": dial tcp: refused' });
    const { text, type, error } = sanitizeUpstreamText(leaked);
    expect(text).not.toContain('S3cret');
    expect(text).not.toContain('admin');
    expect(JSON.parse(text)).toEqual({ type: 'error', value: 'mse: Der Stream ist gerade nicht verfügbar.' });
    expect(type).toBe('error');
    // The original stays available for the hub's own (redacting) log.
    expect(error).toContain('S3cret');
  });

  it('keeps the prefix the app uses to choose a fallback', () => {
    expect(JSON.parse(sanitizeUpstreamText(JSON.stringify({ type: 'error', value: 'webrtc/offer: codecs not matched' })).text).value).toBe('webrtc/offer: Der Stream ist gerade nicht verfügbar.');
    expect(JSON.parse(sanitizeUpstreamText(JSON.stringify({ type: 'error', value: 'something odd' })).text).value).toBe('Der Stream ist gerade nicht verfügbar.');
  });

  it('passes everything else through unchanged', () => {
    const answer = JSON.stringify({ type: 'webrtc/answer', value: 'v=0\r\n' });
    expect(sanitizeUpstreamText(answer)).toEqual({ text: answer, type: 'webrtc/answer', error: null });
    expect(sanitizeUpstreamText('not json')).toEqual({ text: 'not json', type: null, error: null });
  });
});
