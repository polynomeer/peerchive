/**
 * 테스트용 최소 파일 표본. 실제 디코더가 여는 유효한 1×1 이미지와 최소 PDF입니다.
 */
const b64 = (value: string) => Buffer.from(value, 'base64')

export const PNG_1x1 = b64(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
)
export const JPEG_1x1 = b64(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
)
export const GIF_1x1 = b64('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')
export const WEBP_1x1 = b64('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==')
export const PDF_MINIMAL = Buffer.from(
  [
    '%PDF-1.4',
    '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj',
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj',
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 72 72]>>endobj',
    'trailer<</Root 1 0 R>>',
    '%%EOF',
  ].join('\n'),
  'latin1',
)
export const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
export const HTML = Buffer.from('﻿  <!DOCTYPE html><html><body><script>alert(1)</script></body></html>')
export const ZIP_EMPTY = Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64')
export const DOCX_LIKE = Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.alloc(40)])
export const OLE_DOC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0])
export const EXE = Buffer.concat([Buffer.from('MZ', 'latin1'), Buffer.alloc(62)])
export const ELF = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])
export const SHELL = Buffer.from('#!/bin/sh\nrm -rf /\n')
export const EICAR = Buffer.from('X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*', 'latin1')
