'use strict';
/**
 * Minimal ONNX protobuf reader.
 *
 * onnxruntime-node does NOT expose the model metadata map (the Python API has
 * `session.get_modelmeta().custom_metadata_map`), so we parse the ModelProto
 * protobuf directly to recover `metadata_props`.
 *
 * ONNX schema (onnx.proto):
 *   ModelProto.metadata_props = 14  (repeated StringStringEntryProto)
 *   StringStringEntryProto.key = 1 (string), .value = 2 (string)
 */
const fs = require('fs');

function readVarint(buf, pos) {
  let result = 0;
  let shift = 0;
  while (pos < buf.length) {
    const byte = buf[pos++];
    result += (byte & 0x7f) * Math.pow(2, shift);
    if ((byte & 0x80) === 0) break;
    shift += 7;
    if (shift > 63) throw new Error('varint overflow while parsing ONNX metadata');
  }
  return { value: result, pos };
}

/**
 * Walk the top level of a ModelProto and collect metadata_props entries.
 * @param {Buffer} buf
 * @returns {Object<string,string>}
 */
function readOnnxMetadata(buf) {
  const meta = {};
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;

    if (wire === 0) {
      const v = readVarint(buf, pos);
      pos = v.pos;
      continue;
    }
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const data = buf.subarray(pos, pos + len.value);
      pos += len.value;
      if (field === 14) {
        const entry = readStringEntry(data);
        meta[entry.key] = entry.value;
      }
      continue;
    }
    if (wire === 5) {
      pos += 4;
      continue;
    }
    if (wire === 1) {
      pos += 8;
      continue;
    }
    // unsupported wire type -> stop scanning (protobuf groups are not used by ONNX)
    break;
  }
  return meta;
}

function readStringEntry(buf) {
  let key = '';
  let value = '';
  let pos = 0;
  while (pos < buf.length) {
    const tag = readVarint(buf, pos);
    pos = tag.pos;
    const field = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (wire === 2) {
      const len = readVarint(buf, pos);
      pos = len.pos;
      const s = buf.subarray(pos, pos + len.value).toString('utf8');
      pos += len.value;
      if (field === 1) key = s;
      else if (field === 2) value = s;
      continue;
    }
    if (wire === 0) {
      pos = readVarint(buf, pos).pos;
      continue;
    }
    if (wire === 5) {
      pos += 4;
      continue;
    }
    if (wire === 1) {
      pos += 8;
      continue;
    }
    break;
  }
  return { key, value };
}

/** Read the custom metadata map of an ONNX model file. */
function readModelMetadata(modelPath) {
  return readOnnxMetadata(fs.readFileSync(modelPath));
}

module.exports = { readOnnxMetadata, readModelMetadata };
