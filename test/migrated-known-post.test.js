const test=require('node:test'),assert=require('node:assert/strict');
const {inspectPost}=require('../adapters/douyin-phone/harvest');
test('Douyin inspection opens one known post without entering or swiping a location feed', async () => {
  const calls = [];
  const adb = { shell: async (...args) => { calls.push(args); }, wait: async () => {} };
  const node = (text, x, y, width, height) => ({ text, center: [x, y], width, height });
  const read = async () => [node('Observed place', 300, 1650, 200, 60), node('@author', 200, 1740, 300, 70), node('1', 1000, 1650, 100, 60)];
  const videoId = '1234567890123456789';
  const result = await inspectPost(adb, { videoId, read,
    copy: async () => ({ text: `https://www.douyin.com/video/${videoId}` }) });
  assert.equal(result.note_id, videoId);
  assert.equal(result.poi_name, 'Observed place');
  assert.equal(result.poi_id, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes(`snssdk1128://aweme/detail/${videoId}`), true);
  await assert.rejects(inspectPost(adb, { videoId, read,
    copy: async () => ({ text: 'https://www.douyin.com/video/2234567890123456789' }) }),
  { code: 'PHONE_NOTE_MISMATCH' });
});
