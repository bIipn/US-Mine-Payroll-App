import { md5, uid } from '../hash';

describe('md5', () => {
  it('gives the digests of RFC 1321’s test suite, in lower-case hex', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('a')).toBe('0cc175b9c0f1b6a831c399e269772661');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
    expect(md5('message digest')).toBe('f96b697d7cb7938d525a2f31aaf161d0');
    expect(md5('abcdefghijklmnopqrstuvwxyz')).toBe('c3fcd3d76192e4007dfb496cca67e13b');
    expect(md5('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789')).toBe('d174ab98d277d9f5a5611c2c9f419d9f');
    expect(md5('12345678901234567890123456789012345678901234567890123456789012345678901234567890')).toBe('57edf4a22be3c955ac49da2e2107b67a');
  });

  it('hashes the UTF-8 bytes of the text, as RCTMD5Hash does, across block edges', () => {
    // RCTMD5Hash (React Native's RCTUtils) digests string.UTF8String, which is how RNCAsyncStorage names a value's
    // file. The digests are Node's (crypto.createHash('md5').update(text, 'utf8')).
    expect(md5('us-mine-crew-records')).toBe('b3d7faad6465890aa7cfc1042f470520');
    expect(md5('us-mine-crew')).toBe('ddecb47000dd8a6cfee67bcbf0ea65d7');
    expect(md5('Peña ½ mile 🚚')).toBe('5202311c83b92edd41e554fd4ed316d3');
    // The length crosses into a second block at 56 bytes.
    expect(md5('x'.repeat(55))).toBe('04364420e25c512fd958a70738aa8f72');
    expect(md5('x'.repeat(56))).toBe('668a72d5ba17f08e62dabcafad6db14b');
    expect(md5('x'.repeat(64))).toBe('c1bb4f81d892b2d57947682aeb252456');
    expect(md5('é'.repeat(300))).toBe('4bf78d5bfde016534964234b60ced94a');
  });
});

describe('uid', () => {
  it('makes ids that do not clash even when many are made in the same moment, as on a crew of phones', () => {
    const at = jest.spyOn(Date, 'now').mockReturnValue(1_794_000_000_000);
    const ids = Array.from({ length: 20_000 }, () => uid('sh_'));
    at.mockRestore();
    expect(new Set(ids).size).toBe(ids.length);
    // Twelve random characters after the time: about 62 bits.
    expect(ids[0]).toMatch(/^sh_[0-9a-z]{8}[0-9a-z]{12}$/);
  });
});
