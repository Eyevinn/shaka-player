/*! @license
 * Shaka Player
 * Copyright 2016 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

goog.provide('shaka.text.Mp4TtmlParser');

goog.require('goog.asserts');
goog.require('shaka.log');
goog.require('shaka.text.Cue');
goog.require('shaka.text.TextEngine');
goog.require('shaka.text.TtmlTextParser');
goog.require('shaka.util.BufferUtils');
goog.require('shaka.util.Error');
goog.require('shaka.util.Mp4BoxParsers');
goog.require('shaka.util.Mp4Parser');
goog.require('shaka.util.StringUtils');
goog.require('shaka.util.Uint8ArrayUtils');


/**
 * @implements {shaka.extern.TextParser}
 * @export
 */
shaka.text.Mp4TtmlParser = class {
  constructor() {
    /**
     * @type {!shaka.extern.TextParser}
     * @private
     */
    this.parser_ = new shaka.text.TtmlTextParser();

    /**
     * The media timescale, used to turn sample durations into seconds.
     *
     * @type {?number}
     * @private
     */
    this.timescale_ = null;

    /**
     * Whether the sample entry is the experimental paint-model stpc, under
     * which a sample may be a ttmn (nothing changed) or a ttmb (a new body for
     * the head of the last full document).
     *
     * @type {boolean}
     * @private
     */
    this.paintModel_ = false;

    /**
     * Paint model only: the cues of the last document that was parsed, timed
     * as the document is rather than clipped to the sample it came in, so
     * that a ttmn can clip them to its own sample without parsing anything.
     *
     * @type {!Array<!shaka.text.Cue>}
     * @private
     */
    this.lastCues_ = [];

    /**
     * Paint model only: the last full document, whose head a ttmb completes.
     *
     * @type {?string}
     * @private
     */
    this.lastDocument_ = null;
  }

  /**
   * @override
   * @export
   */
  parseInit(data) {
    const Mp4Parser = shaka.util.Mp4Parser;

    let sawSTPP = false;
    this.paintModel_ = false;

    new Mp4Parser()
        .boxes(Mp4Parser.SAMPLE_TABLE_PATH, Mp4Parser.children)
        .fullBox('mdhd', (box) => {
          goog.asserts.assert(
              box.version == 0 || box.version == 1,
              'MDHD version can only be 0 or 1');

          const parsedMDHDBox = shaka.util.Mp4BoxParsers.parseMDHD(
              box.reader, box.version);
          this.timescale_ = parsedMDHDBox.timescale;
        })
        .fullBox('stsd', Mp4Parser.sampleDescription)
        .box('stpp', (box) => {
          sawSTPP = true;
          box.parser.stop();
        })
        .box('stpc', (box) => {
          sawSTPP = true;
          this.paintModel_ = true;
          box.parser.stop();
        }).parse(data);

    if (!sawSTPP) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_MP4_TTML);
    }
  }

  /**
   * @override
   * @export
   */
  setManifestType(manifestType) {
    this.parser_.setManifestType(manifestType);
  }

  /**
   * @override
   * @export
   */
  parseMedia(data, time, uri, images) {
    const Mp4Parser = shaka.util.Mp4Parser;

    let payload = [];
    let defaultSampleSize = null;
    let defaultSampleDuration = null;

    /** @type {!Array<Uint8Array>} */
    const mdats = [];

    /* @type {!Map<number,!Array<number>>} */
    const subSampleSizesPerSample = new Map();

    /** @type {!Array<number>} */
    const sampleSizes = [];

    /**
     * The duration of each sample, in timescale units, or null where the
     * fragment does not give one.
     * @type {!Array<?number>}
     */
    const sampleDurations = [];

    /**
     * The decode time of each sample, in timescale units.  Only differences
     * between these matter, so a fragment without a tfdt simply continues
     * from the previous one.
     * @type {!Array<number>}
     */
    const sampleDecodeTimes = [];
    let decodeTime = 0;

    const parser = new Mp4Parser()
        .boxes(Mp4Parser.FRAGMENT_PATH, Mp4Parser.children)
        .fullBox('tfhd', (box) => {
          goog.asserts.assert(
              box.flags != null,
              'A TFHD box should have a valid flags value');
          const parsedTFHDBox = shaka.util.Mp4BoxParsers.parseTFHD(
              box.reader, box.flags);
          defaultSampleSize = parsedTFHDBox.defaultSampleSize;
          defaultSampleDuration = parsedTFHDBox.defaultSampleDuration;
        })
        .fullBox('tfdt', (box) => {
          goog.asserts.assert(
              box.version == 0 || box.version == 1,
              'TFDT version can only be 0 or 1');

          const parsedTFDTBox = shaka.util.Mp4BoxParsers.parseTFDTInaccurate(
              box.reader, box.version);
          decodeTime = parsedTFDTBox.baseMediaDecodeTime;
        })
        .fullBox('trun', (box) => {
          goog.asserts.assert(
              box.version != null,
              'A TRUN box should have a valid version value');
          goog.asserts.assert(
              box.flags != null,
              'A TRUN box should have a valid flags value');

          const parsedTRUNBox = shaka.util.Mp4BoxParsers.parseTRUN(
              box.reader, box.version, box.flags);

          for (const sample of parsedTRUNBox.sampleData) {
            const sampleSize =
                sample.sampleSize || defaultSampleSize || 0;
            sampleSizes.push(sampleSize);
            const sampleDuration =
                sample.sampleDuration || defaultSampleDuration;
            sampleDurations.push(sampleDuration);
            sampleDecodeTimes.push(decodeTime);
            decodeTime += sampleDuration || 0;
          }
        })
        .fullBox('subs', (box) => {
          const reader = box.reader;
          const entryCount = reader.readUint32();
          let currentSampleNum = -1;
          for (let i = 0; i < entryCount; i++) {
            const sampleDelta = reader.readUint32();
            currentSampleNum += sampleDelta;
            const subsampleCount = reader.readUint16();
            const subsampleSizes = [];
            for (let j = 0; j < subsampleCount; j++) {
              if (box.version == 1) {
                subsampleSizes.push(reader.readUint32());
              } else {
                subsampleSizes.push(reader.readUint16());
              }
              reader.readUint8(); // priority
              reader.readUint8(); // discardable
              reader.readUint32(); // codec_specific_parameters
            }
            subSampleSizesPerSample.set(currentSampleNum, subsampleSizes);
          }
        })
        .box('mdat', Mp4Parser.allData((data) => {
          // We collect all of the mdats first, before parsing any of them.
          // This is necessary in case the mp4 has multiple mdats.
          // They are views on the segment, not cloned, because they will be
          // concatenated and further parsed soon.
          mdats.push(data);
        }, /* clone= */ false));
    parser.parse(data, /* partialOkay= */ false);

    if (mdats.length == 0) {
      throw new shaka.util.Error(
          shaka.util.Error.Severity.CRITICAL,
          shaka.util.Error.Category.TEXT,
          shaka.util.Error.Code.INVALID_MP4_TTML);
    }

    const fullData =
        shaka.util.Uint8ArrayUtils.concat(...mdats);

    const sampleTimes =
        this.getSampleTimes_(sampleDecodeTimes, sampleDurations, time);

    let sampleOffset = 0;
    for (let sampleNum = 0; sampleNum < sampleSizes.length; sampleNum++) {
      let sampleData =
          shaka.util.BufferUtils.toUint8(fullData, sampleOffset,
              sampleSizes[sampleNum]);
      sampleOffset += sampleSizes[sampleNum];

      const subSampleSizes = subSampleSizesPerSample.get(sampleNum);
      const images = [];

      if (subSampleSizes && subSampleSizes.length) {
        const contentData =
            shaka.util.BufferUtils.toUint8(sampleData, 0, subSampleSizes[0]);
        let subOffset = subSampleSizes[0];
        for (let i = 1; i < subSampleSizes.length; i++) {
          const imageData =
              shaka.util.BufferUtils.toUint8(sampleData, subOffset,
                  subSampleSizes[i]);
          const raw =
              shaka.util.Uint8ArrayUtils.toStandardBase64(imageData);
          images.push('data:image/png;base64,' + raw);
          subOffset += subSampleSizes[i];
        }
        sampleData = contentData;
      }
      const sampleTime = sampleTimes ? sampleTimes[sampleNum] : time;
      if (this.paintModel_) {
        payload = payload.concat(this.parsePaintSample_(
            sampleData, sampleTime, time, uri, images));
      } else {
        payload = payload.concat(this.parseDocument_(
            sampleData, sampleTime, uri, images));
      }
    }

    return payload;
  }

  /**
   * Parses one TTML document, counting it in the parse statistics.
   *
   * @param {!Uint8Array} data
   * @param {shaka.extern.TextParser.TimeContext} time
   * @param {?(string|undefined)} uri
   * @param {!Array<string>} images
   * @return {!Array<!shaka.text.Cue>}
   * @private
   */
  parseDocument_(data, time, uri, images) {
    const stats = shaka.text.Mp4TtmlParser.stats_;
    const start = window.performance.now();
    const cues = this.parser_.parseMedia(data, time, uri, images);
    stats.parseMs += window.performance.now() - start;
    stats.documentsParsed++;
    stats.bytesParsed += data.byteLength;
    return cues;
  }

  /**
   * Handles one sample of a paint-model (stpc) track.  A full document and a
   * ttmb are parsed; a ttmn says that nothing changed, so the cues of the last
   * document are clipped to the new sample without parsing anything.
   *
   * A document is parsed as if it lasted to the end of the segment and then
   * clipped to its own sample here.  That keeps the times of its cues as the
   * document gives them, which a later ttmn needs: the same document restated
   * over a later sample would have given exactly those cues, clipped to that
   * sample instead.
   *
   * The 4CCs stpc, ttmn and ttmb are placeholders that are not registered
   * with MP4RA.  See https://github.com/Eyevinn/paint-model-subtitles.
   *
   * @param {!Uint8Array} sampleData
   * @param {shaka.extern.TextParser.TimeContext} sampleTime
   * @param {shaka.extern.TextParser.TimeContext} segmentTime
   * @param {?(string|undefined)} uri
   * @param {!Array<string>} images
   * @return {!Array<!shaka.text.Cue>}
   * @private
   */
  parsePaintSample_(sampleData, sampleTime, segmentTime, uri, images) {
    const Mp4TtmlParser = shaka.text.Mp4TtmlParser;
    const StringUtils = shaka.util.StringUtils;

    const boxType = Mp4TtmlParser.getWholeSampleBoxType_(sampleData);
    if (boxType == 'ttmn') {
      Mp4TtmlParser.stats_.samplesRestated++;
      return Mp4TtmlParser.clipCues_(
          this.lastCues_, sampleTime.segmentStart, sampleTime.segmentEnd);
    }

    /** @type {!Uint8Array} */
    let documentData = sampleData;
    if (boxType == 'ttmb') {
      const body = StringUtils.fromUTF8(
          shaka.util.BufferUtils.toUint8(sampleData, 8));
      const doc = Mp4TtmlParser.spliceBody_(this.lastDocument_, body);
      if (doc == null) {
        shaka.log.warning('A ttmb sample arrived with no document to ' +
            'complete, ignoring it');
        return [];
      }
      documentData = shaka.util.BufferUtils.toUint8(StringUtils.toUTF8(doc));
    } else {
      this.lastDocument_ = StringUtils.fromUTF8(sampleData);
    }

    /** @type {shaka.extern.TextParser.TimeContext} */
    const untilSegmentEnd = {
      periodStart: sampleTime.periodStart,
      segmentStart: sampleTime.segmentStart,
      segmentEnd: segmentTime.segmentEnd,
      vttOffset: sampleTime.vttOffset,
      isMpegTs: sampleTime.isMpegTs,
    };
    this.lastCues_ =
        this.parseDocument_(documentData, untilSegmentEnd, uri, images);
    return Mp4TtmlParser.clipCues_(
        this.lastCues_, sampleTime.segmentStart, sampleTime.segmentEnd);
  }

  /**
   * Returns the type of the box that is the whole sample, when the sample is
   * a ttmn or a ttmb, and null otherwise.  The test is exact: a box header of
   * one of those types whose size is the sample size.  A TTML document cannot
   * match, since it cannot start with the zero byte that opens a box size.
   *
   * @param {!Uint8Array} sampleData
   * @return {?string}
   * @private
   */
  static getWholeSampleBoxType_(sampleData) {
    if (sampleData.byteLength < 8) {
      return null;
    }
    const view = shaka.util.BufferUtils.toDataView(sampleData);
    if (view.getUint32(0) != sampleData.byteLength) {
      return null;
    }
    const type = shaka.util.Mp4Parser.typeToString(view.getUint32(4));
    return type == 'ttmn' || type == 'ttmb' ? type : null;
  }

  /**
   * Puts a body sent on its own in place of the body of a full document, so
   * that everything around it - the tt element with its namespaces, and the
   * head - is kept exactly.
   *
   * @param {?string} doc
   * @param {string} body
   * @return {?string} null when there is no document to complete
   * @private
   */
  static spliceBody_(doc, body) {
    const bodyElement = /<body[\s\S]*<\/body\s*>/;
    if (!doc || !bodyElement.test(doc)) {
      return null;
    }
    return doc.replace(bodyElement, () => body.trim());
  }

  /**
   * Returns copies of the cues clipped to [start, end), leaving out any cue,
   * or nested cue, that does not overlap it.
   *
   * @param {!Array<!shaka.text.Cue>} cues
   * @param {number} start
   * @param {number} end
   * @return {!Array<!shaka.text.Cue>}
   * @private
   */
  static clipCues_(cues, start, end) {
    /** @type {!Array<!shaka.text.Cue>} */
    const clipped = [];
    for (const cue of cues) {
      if (cue.endTime <= start || cue.startTime >= end) {
        continue;
      }
      const copy = cue.clone();
      copy.startTime = Math.max(copy.startTime, start);
      copy.endTime = Math.min(copy.endTime, end);
      copy.nestedCues =
          shaka.text.Mp4TtmlParser.clipCues_(copy.nestedCues, start, end);
      clipped.push(copy);
    }
    return clipped;
  }

  /**
   * Experimental: what the MP4 TTML parsers of this page have done so far, to
   * compare how much parsing a paint-model (stpc) track saves over stpp.
   *
   * The keys are quoted so that they keep their names in compiled builds:
   * documentsParsed, bytesParsed, samplesRestated and parseMs.
   *
   * @return {!Object<string, number>}
   * @export
   */
  static getParseStats() {
    const stats = shaka.text.Mp4TtmlParser.stats_;
    return {
      'documentsParsed': stats.documentsParsed,
      'bytesParsed': stats.bytesParsed,
      'samplesRestated': stats.samplesRestated,
      'parseMs': stats.parseMs,
    };
  }

  /**
   * Experimental: sets the parse statistics back to zero.
   *
   * @export
   */
  static resetParseStats() {
    const stats = shaka.text.Mp4TtmlParser.stats_;
    stats.documentsParsed = 0;
    stats.bytesParsed = 0;
    stats.samplesRestated = 0;
    stats.parseMs = 0;
  }

  /**
   * Gives each sample of the segment the part of the timeline that is its own,
   * so that a document is clipped to its own sample rather than to the whole
   * segment, per ISO/IEC 14496-30 Section 5.9(4).  With one sample per segment
   * the two are the same thing, which is why this returns null for that case
   * and for any fragment that does not give every sample a duration: the
   * samples cannot be timed individually then, so the segment stays one unit.
   *
   * @param {!Array<number>} sampleDecodeTimes in timescale units
   * @param {!Array<?number>} sampleDurations in timescale units
   * @param {shaka.extern.TextParser.TimeContext} time
   * @return {?Array<shaka.extern.TextParser.TimeContext>}
   * @private
   */
  getSampleTimes_(sampleDecodeTimes, sampleDurations, time) {
    const timescale = this.timescale_;
    if (!timescale || sampleDurations.length < 2) {
      return null;
    }

    /** @type {!Array<number>} */
    const durations = [];
    for (const duration of sampleDurations) {
      if (!duration) {
        return null;
      }
      durations.push(duration);
    }

    const clamp = (t) =>
      Math.min(Math.max(t, time.segmentStart), time.segmentEnd);

    // The first sample starts where the segment does. Only the offsets from it
    // come from the decode times, which are on the media timeline and so
    // cannot be compared with the segment times directly.
    const baseDecodeTime = sampleDecodeTimes[0];

    /** @type {!Array<shaka.extern.TextParser.TimeContext>} */
    const sampleTimes = [];
    for (let i = 0; i < durations.length; i++) {
      const start = time.segmentStart +
          (sampleDecodeTimes[i] - baseDecodeTime) / timescale;
      const end = start + durations[i] / timescale;
      sampleTimes.push({
        periodStart: time.periodStart,
        segmentStart: clamp(start),
        segmentEnd: clamp(end),
        vttOffset: time.vttOffset,
        isMpegTs: time.isMpegTs,
      });
    }
    // The durations need not add up to the exact length of the segment, so let
    // the last sample run to the end of it, as a single sample already does.
    sampleTimes[sampleTimes.length - 1].segmentEnd = time.segmentEnd;
    return sampleTimes;
  }
};


/**
 * @const {{documentsParsed: number, bytesParsed: number,
 *          samplesRestated: number, parseMs: number}}
 * @private
 */
shaka.text.Mp4TtmlParser.stats_ = {
  documentsParsed: 0,
  bytesParsed: 0,
  samplesRestated: 0,
  parseMs: 0,
};


shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp"', () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.im1i"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.im1t"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.im2i"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.im2t"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.etd1"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.etd1|im1t"',
    () => new shaka.text.Mp4TtmlParser());
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.ttml.im1t|etd1"',
    () => new shaka.text.Mp4TtmlParser());

// Legacy codec string uses capital "TTML", i.e.: prior to HLS rfc8216bis:
//   Note that if a Variant Stream specifies one or more Renditions that
//   include IMSC subtitles, the CODECS attribute MUST indicate this with a
//   format identifier such as "stpp.ttml.im1t".
// (https://tools.ietf.org/html/draft-pantos-hls-rfc8216bis-05#section-4.4.5.2)
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpp.TTML.im1t"',
    () => new shaka.text.Mp4TtmlParser());

// Experimental paint-model TTML, with an unregistered placeholder 4CC.
shaka.text.TextEngine.registerParser(
    'application/mp4; codecs="stpc"', () => new shaka.text.Mp4TtmlParser());
