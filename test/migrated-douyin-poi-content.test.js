// The Douyin 地点内容 harvest (core/douyin_poi_content.js): what it reads off the
// phone screen, and when it stops. Screens as dumped on the S24, 2026-10-11.
const test = require('node:test');
const assert = require('node:assert/strict');
const { cardsOf, locationLine, checkFor, resolve } = require('../adapters/douyin-phone/harvest');

const node = (attrs, [x1, y1, x2, y2]) => ({ ...attrs, center: [(x1 + x2) >> 1, (y1 + y2) >> 1], width: x2 - x1, height: y2 - y1 });

test('sheet cards pair each author with the card title above it, not with a badge', () => {
  const nodes = [
    node({ 'content-desc': 'sunny bb 我地好挂住你 #糖莎翁 #香港特产 #浙江女婿' }, [45, 1862, 511, 1964]),
    node({ 'content-desc': '关注的人打卡过' }, [45, 1940, 511, 1980]),
    node({ 'content-desc': 'Evelyn🐳' }, [101, 1992, 235, 2037]),
    node({ 'content-desc': '上海新开！！不在曼哈顿！！在上海📸📸' }, [569, 1862, 1035, 1964]),
    node({ 'content-desc': '米米米兰兰兰' }, [625, 1992, 811, 2037]),
    node({ 'content-desc': '返回' }, [34, 136, 124, 226]),
  ];
  assert.deepEqual(cardsOf(nodes).map((c) => [c.author, c.title.slice(0, 8)]),
    [['Evelyn🐳', 'sunny bb'], ['米米米兰兰兰', '上海新开！！不在']]);
});

test('the location line is the left-hand text just above the author, not a city or a count', () => {
  const nodes = [
    node({ text: '附近' }, [124, 1614, 198, 1672]),
    node({ text: 'ATELIER玖楼' }, [240, 1614, 460, 1672]),
    node({ text: '131' }, [958, 1640, 1047, 1700]),
    node({ text: '@酒玩家奥利弗' }, [33, 1705, 345, 1775]),
  ];
  assert.equal(locationLine(nodes).text, 'ATELIER玖楼');
});

test('a Douyin check on the phone is recognised, an ordinary screen is not', () => {
  assert.ok(checkFor([node({ text: '请完成下列验证后继续' }, [0, 0, 10, 10])]));
  assert.ok(checkFor([], 'com.ss.android.ugc.aweme/.SecVerifyActivity'));
  assert.equal(checkFor([node({ text: 'ATELIER玖楼' }, [0, 0, 10, 10])], 'com.ss.android.ugc.aweme/.detail.ui.DetailActivity'), null);
});

test('a share text becomes the video id; a short link is followed once', async () => {
  assert.equal((await resolve('看看 https://www.douyin.com/video/7686405267591810323 ')).id, '7686405267591810323');
  const fake = async () => ({ headers: new Map([['location', 'https://www.iesdouyin.com/share/video/7688761762985090880/?region=CN']]) });
  const got = await resolve('8.25 复制打开抖音，看看… https://v.douyin.com/cqOhIja3ndc/ i@P.kp', fake);
  assert.deepEqual(got, { id: '7688761762985090880', link: 'https://v.douyin.com/cqOhIja3ndc/' });
});

test('link resolution preserves the observed URL and rejects a foreign host or redirect', async () => {
  const link = 'https://www.iesdouyin.com/share/slides/7670008774199806579/?region=CN';
  assert.deepEqual(await resolve(link), { id: '7670008774199806579', link });
  assert.equal(await resolve('https://untrusted.example/video/7670008774199806579'), null);
  const foreign = async () => ({ headers: new Map([['location', 'https://untrusted.example/video/7670008774199806579']]) });
  assert.equal(await resolve('https://v.douyin.com/example/', foreign), null);
});
