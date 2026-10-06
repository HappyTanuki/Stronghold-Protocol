# Original non-Hangul fonts

`public/fonts/fonts.css` registers the original Bender regular/light and Novecento Wide normal faces, served from the external asset mount at `/assets/overlay-fonts/`.

Stage these original files in `public/assets/overlay-fonts/` before starting an image:
- bender-regular.woff2 and bender-regular.otf
- bender-light.woff2 and bender-light.ttf
- novecento-wide-normal.woff2 and novecento-wide-normal.otf

The deployed files were copied byte-for-byte from the existing original resource installation; font binaries are not added to this repository. Preserve this directory when creating a new private resource tree.

Nanum Gothic remains restricted to Hangul by `public/i18n/ko/ko.css`. Original CSS family stacks are retained for all other characters.

Verification against served production CSS/fonts in isolated Chrome DOM nodes, using CDP CSS.getPlatformFontsForNode:
- Korean sample: NanumGothic, custom font, 5 glyphs
- numeric sample: Bender, custom font, 10 glyphs
- display Latin sample: Novecento wide, custom font, 6 glyphs

No game sessions or rendering logic were modified by the font probe.
