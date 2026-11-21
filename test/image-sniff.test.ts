import test from "node:test";
import assert from "node:assert/strict";
import { driveIdFromUrl, sniffImage, typeSaysNotImage } from "../src/image-sniff.ts";

const bytes = (...a: number[]) => new Uint8Array([...a, ...new Array(16).fill(0)]);

test("先頭のバイトで画像を見分ける（png・jpeg・gif・webp）", () => {
  assert.equal(sniffImage(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)), "image/png");
  assert.equal(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0)), "image/jpeg");
  assert.equal(sniffImage(bytes(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)), "image/gif");
  assert.equal(sniffImage(new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50, 0, 0])), "image/webp");
});

test("ドライブのログイン画面（HTML）や短すぎるものは画像ではない", () => {
  assert.equal(sniffImage(new TextEncoder().encode("<!DOCTYPE html><html lang=\"ja\"><head>")), null);
  assert.equal(sniffImage(new Uint8Array([0x89, 0x50])), null);
});

test("Content-Type：text/html は画像でない。空や octet-stream は中身で決める", () => {
  assert.equal(typeSaysNotImage("text/html; charset=utf-8"), true);
  assert.equal(typeSaysNotImage("image/png"), false);
  assert.equal(typeSaysNotImage("application/octet-stream"), false);
  assert.equal(typeSaysNotImage(""), false);
});

test("ドライブの住所から番号を取り出す", () => {
  const id = "1N3tZ31dkp2vYiEfDeU2UAd-nQq8XK-lE";
  assert.equal(driveIdFromUrl(`https://drive.google.com/file/d/${id}/view?usp=drivesdk`), id);
  assert.equal(driveIdFromUrl(`https://drive.google.com/open?id=${id}`), id);
  assert.equal(driveIdFromUrl(`https://drive.google.com/uc?export=download&id=${id}`), id);
  assert.equal(driveIdFromUrl(`https://drive.usercontent.google.com/download?id=${id}&export=download`), id);
  assert.equal(driveIdFromUrl("https://files.oaiusercontent.com/file-abc?sig=1"), null);
  assert.equal(driveIdFromUrl("not a url"), null);
});
