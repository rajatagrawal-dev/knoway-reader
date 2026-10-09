import test from "node:test";
import assert from "node:assert/strict";
import { NavigationHistory, placeFromScroll, scrollTopForPlace } from "./history.ts";

test("a place survives zoom: same fraction of the page, new pixel offsets", () => {
  const place = placeFromScroll(1150, 3, { top: 1000, bottom: 1600 });
  assert.deepEqual(place, { pageNumber: 3, offset: 0.25 });
  // Zoomed 2x: page 3 now starts at 2000 and is 1200 tall.
  assert.equal(scrollTopForPlace(place, { top: 2000, bottom: 3200 }), 2300);
});

test("offsets are clamped to the page", () => {
  assert.equal(placeFromScroll(900, 3, { top: 1000, bottom: 1600 }).offset, 0);
  assert.equal(placeFromScroll(1700, 3, { top: 1000, bottom: 1600 }).offset, 1);
  assert.equal(placeFromScroll(5, 1, { top: 0, bottom: 0 }).offset, 0);
});

const at = (pageNumber: number, offset = 0) => ({ pageNumber, offset });
const pages = (places: { pageNumber: number }[]) => places.map((place) => place.pageNumber);

test("back steps through every place left, most recent first", () => {
  const history = new NavigationHistory();
  history.push(at(1));
  history.push(at(5));
  history.push(at(9));
  assert.deepEqual(pages(history.backList()), [9, 5, 1]);
  assert.equal(history.back(at(20))?.pageNumber, 9);
  assert.equal(history.back(at(9))?.pageNumber, 5);
  assert.equal(history.back(at(5))?.pageNumber, 1);
  assert.equal(history.back(at(1)), null);
  // Forward retraces them, nearest first.
  assert.deepEqual(pages(history.forwardList()), [5, 9, 20]);
});

test("forward returns to where back left, and back again", () => {
  const history = new NavigationHistory();
  history.push(at(3));
  assert.equal(history.back(at(40, 0.5))?.pageNumber, 3);
  assert.deepEqual(history.forward(at(3)), at(40, 0.5));
  assert.equal(history.forward(at(40, 0.5)), null);
  assert.equal(history.back(at(40, 0.5))?.pageNumber, 3);
});

test("several steps at once keep the places stepped over", () => {
  const history = new NavigationHistory();
  for (const page of [1, 2, 3, 4]) history.push(at(page));
  assert.equal(history.back(at(10), 3)?.pageNumber, 2);
  assert.deepEqual(pages(history.backList()), [1]);
  assert.deepEqual(pages(history.forwardList()), [3, 4, 10]);
  assert.equal(history.forward(at(2), 2)?.pageNumber, 4);
  assert.deepEqual(pages(history.backList()), [3, 2, 1]);
  assert.deepEqual(pages(history.forwardList()), [10]);
  assert.equal(history.back(at(4), 5), null);
});

test("a new jump forgets what was ahead", () => {
  const history = new NavigationHistory();
  history.push(at(1));
  history.back(at(8));
  history.push(at(1, 0.5));
  assert.deepEqual(history.forwardList(), []);
  history.back(at(12));
  history.discardForward();
  assert.deepEqual(history.forwardList(), []);
});

test("leaving the same place twice records it once", () => {
  const history = new NavigationHistory();
  history.push(at(4, 0.3));
  history.push(at(4, 0.31));
  history.push(at(4, 0.6));
  assert.deepEqual(history.backList(), [at(4, 0.6), at(4, 0.3)]);
});

test("each list forgets its oldest places past its limit", () => {
  const history = new NavigationHistory();
  for (let page = 1; page <= 25; page += 1) history.push(at(page));
  const back = pages(history.backList());
  assert.equal(back.length, 20);
  assert.equal(back[0], 25);
  assert.equal(back[19], 6);
});
