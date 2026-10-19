import { describe, expect, it } from 'vitest'
import { decideFileType } from '@peerchive/domain'
import { inspectContent, sniff } from '../src'
import {
  DOCX_LIKE,
  EICAR,
  ELF,
  EXE,
  GIF_1x1,
  HTML,
  JPEG_1x1,
  OLE_DOC,
  PDF_MINIMAL,
  PNG_1x1,
  SHELL,
  SVG,
  WEBP_1x1,
  ZIP_EMPTY,
} from './samples'

describe('sniff', () => {
  it.each([
    ['PNG', PNG_1x1, 'image/png'],
    ['JPEG', JPEG_1x1, 'image/jpeg'],
    ['GIF', GIF_1x1, 'image/gif'],
    ['WebP', WEBP_1x1, 'image/webp'],
    ['PDF', PDF_MINIMAL, 'application/pdf'],
  ] as const)('detects real %s samples', (_, sample, expected) => {
    expect(sniff(sample)).toBe(expected)
  })

  it.each([
    ['SVG with XML prolog', SVG, 'svg'],
    ['bare SVG', Buffer.from('  <svg onload="x()"/>'), 'svg'],
    ['HTML with BOM and whitespace', HTML, 'html'],
    ['HTML comment', Buffer.from('<!-- x --><p>hi'), 'html'],
    ['uppercase HTML', Buffer.from('<HTML><BODY>'), 'html'],
    ['UTF-16 HTML', Buffer.from('﻿<html>', 'utf16le'), 'html'],
    ['XML', Buffer.from('<?xml version="1.0"?><root/>'), 'xml'],
    ['other markup', Buffer.from('<custom-tag>'), 'xml'],
    ['empty ZIP', ZIP_EMPTY, 'zip'],
    ['Office Open XML (ZIP)', DOCX_LIKE, 'zip'],
    ['legacy Office (OLE)', OLE_DOC, 'ole'],
    ['Windows executable', EXE, 'executable'],
    ['ELF executable', ELF, 'executable'],
    ['shell script', SHELL, 'script'],
    ['PHP', Buffer.from('<?php echo 1;'), 'script'],
    ['EICAR text', EICAR, 'unknown'],
    ['plain text', Buffer.from('hello'), 'unknown'],
    ['empty', Buffer.alloc(0), 'unknown'],
    ['PDF header not at offset 0', Buffer.concat([Buffer.from('junk'), PDF_MINIMAL]), 'unknown'],
    ['truncated PNG signature', PNG_1x1.subarray(0, 4), 'unknown'],
    ['RIFF but not WebP (WAV)', Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'), 'unknown'],
  ] as const)('classifies %s', (_, sample, expected) => {
    expect(sniff(sample)).toBe(expected)
  })

  it('HTML disguised with a .png name and declared image/png is quarantined', () => {
    expect(decideFileType('image/png', 'photo.png', sniff(HTML))).toEqual({ ok: false, reason: 'disallowed_type' })
  })

  it('a real JPEG declared as PNG is a type mismatch', () => {
    expect(decideFileType('image/png', 'photo.png', sniff(JPEG_1x1))).toEqual({ ok: false, reason: 'type_mismatch' })
  })
})

describe('inspectContent (polyglot-ish files)', () => {
  it('passes clean samples', () => {
    expect(inspectContent(PNG_1x1, 'image/png')).toBeNull()
    expect(inspectContent(JPEG_1x1, 'image/jpeg')).toBeNull()
    expect(inspectContent(GIF_1x1, 'image/gif')).toBeNull()
    expect(inspectContent(WEBP_1x1, 'image/webp')).toBeNull()
    expect(inspectContent(PDF_MINIMAL, 'application/pdf')).toBeNull()
  })

  it('flags markup hidden right after an image signature (GIF/HTML polyglot)', () => {
    const polyglot = Buffer.concat([Buffer.from('GIF89a/*', 'latin1'), Buffer.from('<script>alert(1)</script>')])
    expect(sniff(polyglot)).toBe('image/gif')
    expect(inspectContent(polyglot, 'image/gif')).toBe('embedded_content')
  })

  it('flags a ZIP archive appended to an image', () => {
    expect(inspectContent(Buffer.concat([PNG_1x1, ZIP_EMPTY]), 'image/png')).toBe('embedded_content')
  })

  it('flags PDF JavaScript, launch actions and embedded files, including #xx-escaped names', () => {
    const withJs = Buffer.concat([PDF_MINIMAL, Buffer.from('\n4 0 obj<</S/JavaScript/JS(app.alert(1))>>endobj')])
    expect(inspectContent(withJs, 'application/pdf')).toBe('pdf_active_content')
    const escaped = Buffer.concat([PDF_MINIMAL, Buffer.from('\n4 0 obj<</S/J#61vaScript>>endobj')])
    expect(inspectContent(escaped, 'application/pdf')).toBe('pdf_active_content')
    const launch = Buffer.concat([PDF_MINIMAL, Buffer.from('\n<</S/Launch/F(cmd.exe)>>')])
    expect(inspectContent(launch, 'application/pdf')).toBe('pdf_active_content')
    const embedded = Buffer.concat([PDF_MINIMAL, Buffer.from('\n<</EmbeddedFiles 5 0 R>>')])
    expect(inspectContent(embedded, 'application/pdf')).toBe('pdf_active_content')
  })

  it('does not flag names that merely start like active ones', () => {
    const benign = Buffer.concat([PDF_MINIMAL, Buffer.from('\n<</JSONData 1>>')])
    expect(inspectContent(benign, 'application/pdf')).toBeNull()
  })
})
