import { promises as fsp } from 'fs';
import { instantiateEmscriptenWasm, pathify } from './emscripten-utils.js';

// MozJPEG
import mozEnc from '../../codecs/mozjpeg/enc/mozjpeg_node_enc.js';
import mozEncWasm from 'asset-url:../../codecs/mozjpeg/enc/mozjpeg_node_enc.wasm';
import mozDec from '../../codecs/mozjpeg/dec/mozjpeg_node_dec.js';
import mozDecWasm from 'asset-url:../../codecs/mozjpeg/dec/mozjpeg_node_dec.wasm';

// WebP
import webpEnc from '../../codecs/webp/enc/webp_node_enc.js';
import webpEncWasm from 'asset-url:../../codecs/webp/enc/webp_node_enc.wasm';
import webpDec from '../../codecs/webp/dec/webp_node_dec.js';
import webpDecWasm from 'asset-url:../../codecs/webp/dec/webp_node_dec.wasm';

// AVIF
import avifEnc from '../../codecs/avif/enc/avif_node_enc.js';
import avifEncWasm from 'asset-url:../../codecs/avif/enc/avif_node_enc.wasm';
import avifDec from '../../codecs/avif/dec/avif_node_dec.js';
import avifDecWasm from 'asset-url:../../codecs/avif/dec/avif_node_dec.wasm';

// SVG
// import puppeteer from "puppeteer";
const puppeteer = require('puppeteer');

// JXL
import jxlEnc from '../../codecs/jxl/enc/jxl_node_enc.js';
import jxlEncWasm from 'asset-url:../../codecs/jxl/enc/jxl_node_enc.wasm';
import jxlDec from '../../codecs/jxl/dec/jxl_node_dec.js';
import jxlDecWasm from 'asset-url:../../codecs/jxl/dec/jxl_node_dec.wasm';

// WP2
import wp2Enc from '../../codecs/wp2/enc/wp2_node_enc.js';
import wp2EncWasm from 'asset-url:../../codecs/wp2/enc/wp2_node_enc.wasm';
import wp2Dec from '../../codecs/wp2/dec/wp2_node_dec.js';
import wp2DecWasm from 'asset-url:../../codecs/wp2/dec/wp2_node_dec.wasm';

// PNG
import * as pngEncDec from '../../codecs/png/pkg/squoosh_png.js';
import pngEncDecWasm from 'asset-url:../../codecs/png/pkg/squoosh_png_bg.wasm';
const pngEncDecPromise = pngEncDec.default(
  fsp.readFile(pathify(pngEncDecWasm)),
);

// OxiPNG
import * as oxipng from '../../codecs/oxipng/pkg/squoosh_oxipng.js';
import oxipngWasm from 'asset-url:../../codecs/oxipng/pkg/squoosh_oxipng_bg.wasm';
const oxipngPromise = oxipng.default(fsp.readFile(pathify(oxipngWasm)));

// Resize
import * as resize from '../../codecs/resize/pkg/squoosh_resize.js';
import resizeWasm from 'asset-url:../../codecs/resize/pkg/squoosh_resize_bg.wasm';
const resizePromise = resize.default(fsp.readFile(pathify(resizeWasm)));

// rotate
import rotateWasm from 'asset-url:../../codecs/rotate/rotate.wasm';

// ImageQuant
import imageQuant from '../../codecs/imagequant/imagequant_node.js';
import imageQuantWasm from 'asset-url:../../codecs/imagequant/imagequant_node.wasm';
const imageQuantPromise = instantiateEmscriptenWasm(imageQuant, imageQuantWasm);

// Our decoders currently rely on a `ImageData` global.
import ImageData from './image_data.js';
globalThis.ImageData = ImageData;

function resizeNameToIndex(name) {
  switch (name) {
    case 'triangle':
      return 0;
    case 'catrom':
      return 1;
    case 'mitchell':
      return 2;
    case 'lanczos3':
      return 3;
    default:
      throw Error(`Unknown resize algorithm "${name}"`);
  }
}

function resizeWithAspect({
  input_width,
  input_height,
  target_width,
  target_height,
}) {
  if (!target_width && !target_height) {
    throw Error('Need to specify at least width or height when resizing');
  }
  if (target_width && target_height) {
    return { width: target_width, height: target_height };
  }
  if (!target_width) {
    return {
      width: Math.round((input_width / input_height) * target_height),
      height: target_height,
    };
  }
  if (!target_height) {
    return {
      width: target_width,
      height: Math.round((input_height / input_width) * target_width),
    };
  }
}

export const preprocessors = {
  resize: {
    name: 'Resize',
    description: 'Resize the image before compressing',
    instantiate: async () => {
      await resizePromise;
      return (
        buffer,
        input_width,
        input_height,
        { width, height, method, premultiply, linearRGB },
      ) => {
        ({ width, height } = resizeWithAspect({
          input_width,
          input_height,
          target_width: width,
          target_height: height,
        }));
        return new ImageData(
          resize.resize(
            buffer,
            input_width,
            input_height,
            width,
            height,
            resizeNameToIndex(method),
            premultiply,
            linearRGB,
          ),
          width,
          height,
        );
      };
    },
    defaultOptions: {
      method: 'lanczos3',
      fitMethod: 'stretch',
      premultiply: true,
      linearRGB: true,
    },
  },
  // // TODO: Need to handle SVGs and HQX
  quant: {
    name: 'ImageQuant',
    description: 'Reduce the number of colors used (aka. paletting)',
    instantiate: async () => {
      const imageQuant = await imageQuantPromise;
      return (buffer, width, height, { numColors, dither }) =>
        new ImageData(
          imageQuant.quantize(buffer, width, height, numColors, dither),
          width,
          height,
        );
    },
    defaultOptions: {
      numColors: 255,
      dither: 1.0,
    },
  },
  rotate: {
    name: 'Rotate',
    description: 'Rotate image',
    instantiate: async () => {
      return async (buffer, width, height, { numRotations }) => {
        const degrees = (numRotations * 90) % 360;
        const sameDimensions = degrees == 0 || degrees == 180;
        const size = width * height * 4;
        const { instance } = await WebAssembly.instantiate(
          await fsp.readFile(pathify(rotateWasm)),
        );
        const { memory } = instance.exports;
        const additionalPagesNeeded = Math.ceil(
          (size * 2 - memory.buffer.byteLength + 8) / (64 * 1024),
        );
        if (additionalPagesNeeded > 0) {
          memory.grow(additionalPagesNeeded);
        }
        const view = new Uint8ClampedArray(memory.buffer);
        view.set(buffer, 8);
        instance.exports.rotate(width, height, degrees);
        return new ImageData(
          view.slice(size + 8, size * 2 + 8),
          sameDimensions ? width : height,
          sameDimensions ? height : width,
        );
      };
    },
    defaultOptions: {
      numRotations: 0,
    },
  },
};

export const codecs = {
  mozjpeg: {
    name: 'MozJPEG',
    extension: 'jpg',
    detectors: [/^\xFF\xD8\xFF/],
    dec: () => instantiateEmscriptenWasm(mozDec, mozDecWasm),
    enc: () => instantiateEmscriptenWasm(mozEnc, mozEncWasm),
    defaultEncoderOptions: {
      quality: 75,
      baseline: false,
      arithmetic: false,
      progressive: true,
      optimize_coding: true,
      smoothing: 0,
      color_space: 3 /*YCbCr*/,
      quant_table: 3,
      trellis_multipass: false,
      trellis_opt_zero: false,
      trellis_opt_table: false,
      trellis_loops: 1,
      auto_subsample: true,
      chroma_subsample: 2,
      separate_chroma_quality: false,
      chroma_quality: 75,
    },
    autoOptimize: {
      option: 'quality',
      min: 0,
      max: 100,
    },
  },
  webp: {
    name: 'WebP',
    extension: 'webp',
    detectors: [/^RIFF....WEBPVP8[LX ]/],
    dec: () => instantiateEmscriptenWasm(webpDec, webpDecWasm),
    enc: () => instantiateEmscriptenWasm(webpEnc, webpEncWasm),
    defaultEncoderOptions: {
      quality: 75,
      target_size: 0,
      target_PSNR: 0,
      method: 4,
      sns_strength: 50,
      filter_strength: 60,
      filter_sharpness: 0,
      filter_type: 1,
      partitions: 0,
      segments: 4,
      pass: 1,
      show_compressed: 0,
      preprocessing: 0,
      autofilter: 0,
      partition_limit: 0,
      alpha_compression: 1,
      alpha_filtering: 1,
      alpha_quality: 100,
      lossless: 0,
      exact: 0,
      image_hint: 0,
      emulate_jpeg_size: 0,
      thread_level: 0,
      low_memory: 0,
      near_lossless: 100,
      use_delta_palette: 0,
      use_sharp_yuv: 0,
    },
    autoOptimize: {
      option: 'quality',
      min: 0,
      max: 100,
    },
  },
  avif: {
    name: 'AVIF',
    extension: 'avif',
    detectors: [/^\x00\x00\x00 ftypavif\x00\x00\x00\x00/],
    dec: () => instantiateEmscriptenWasm(avifDec, avifDecWasm),
    enc: () => instantiateEmscriptenWasm(avifEnc, avifEncWasm),
    defaultEncoderOptions: {
      minQuantizer: 33,
      maxQuantizer: 63,
      minQuantizerAlpha: 33,
      maxQuantizerAlpha: 63,
      tileColsLog2: 0,
      tileRowsLog2: 0,
      speed: 8,
      subsample: 1,
    },
    autoOptimize: {
      option: 'maxQuantizer',
      min: 0,
      max: 62,
    },
  },
  svg: {
    name: 'SVG',
    extension: 'svg',
    detectors: [/^<svg/], // This will certainly break if there are comments or other markup that come before the svg tag
    dec: async () => {
      const testImageData = new Uint8Array([
        255,
        0,
        0,
        255,
        255,
        0,
        0,
        255,
        255,
        0,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        255,
        0,
        0,
        255,
        255,
        0,
        0,
        255,
        255,
        0,
        0,
        255,
        255,
      ]);

      const browser = await puppeteer.launch({
        headless: false,
        devtools: true,
      });
      const page = await browser.newPage();

      console.log('Browser page loaded');

      return {
        decode: async (data) => {
          const svgText = new TextDecoder().decode(data);

          const result = await page.evaluate(async (svgText) => {
            function readBinaryStringFromArrayBuffer(arrayBuffer) {
              return new Promise((resolve, reject) => {
                var reader = new FileReader();

                reader.onload = function (event) {
                  resolve(event.target.result);
                };
                reader.onerror = function (event) {
                  reject(event.target.error);
                };
                reader.readAsBinaryString(
                  new Blob([arrayBuffer], { type: 'application/octet-stream' }),
                );
              });
            }

            async function decodeImage(url) {
              const img = new Image();
              img.decoding = 'async';
              img.src = url;
              const loaded = new Promise((resolve, reject) => {
                img.onload = () => resolve();
                // img.onerror = () => reject(Error('Image loading error'));
              });

              if (img.decode) {
                // Nice off-thread way supported in Safari/Chrome.
                // Safari throws on decode if the source is SVG.
                // https://bugs.webkit.org/show_bug.cgi?id=188347
                await img.decode().catch(() => null);
              }

              // Always await loaded, as we may have bailed due to the Safari bug above.
              await loaded;
              return img;
            }

            async function blobToImg(blob) {
              const url = URL.createObjectURL(blob);

              try {
                return await decodeImage(url);
              } finally {
                URL.revokeObjectURL(url);
              }
            }

            const svgBytes = new TextEncoder().encode(svgText);

            const image = await blobToImg(
              new Blob([svgBytes], { type: 'image/svg+xml' }),
            );
            console.log(image);
            // const svg = document.querySelector("svg");
            const canvas = document.createElement('canvas');
            canvas.width = 512;
            canvas.height = 516;
            document.body.appendChild(canvas);
            const context = canvas.getContext('2d');
            context.drawImage(image, 0, 0);

            const imageData = context.getImageData(0, 0, 512, 516);
            // return new TextDecoder().decode("peter");
            console.log(imageData);
            return readBinaryStringFromArrayBuffer(imageData.data);

            // if (svg.hasAttribute('width') && svg.hasAttribute('height')) {
            //   return blobToImg(blob);
            // }

            // const viewBox = svg.getAttribute('viewBox');
            // if (viewBox === null) throw Error('SVG must have width/height or viewBox');

            // const viewboxParts = viewBox.split(/\s+/);
            // svg.setAttribute('width', viewboxParts[2]);
            // svg.setAttribute('height', viewboxParts[3]);

            // const serializer = new XMLSerializer();
            // const newSource = serializer.serializeToString(document);
            // return blobToImg(new Blob([newSource], { type: 'image/svg+xml' }));
          }, svgText);

          const pixelBytes = new Uint8Array(Buffer.from(result, 'binary'));

          return new ImageData(pixelBytes, 512, 516);
        },
      };
    },
    enc: async () => {
      await pngEncDecPromise;
      await oxipngPromise;
      return {
        encode: (buffer, width, height, opts) => {
          // must return a Uint8Array
        },
      };
    },
    defaultEncoderOptions: {
      // minQuantizer: 33,
      // maxQuantizer: 63,
      // minQuantizerAlpha: 33,
      // maxQuantizerAlpha: 63,
      // tileColsLog2: 0,
      // tileRowsLog2: 0,
      // speed: 8,
      // subsample: 1,
    },
    // autoOptimize: {
    //   option: 'maxQuantizer',
    //   min: 0,
    //   max: 62,
    // },
  },
  jxl: {
    name: 'JPEG-XL',
    extension: 'jxl',
    detectors: [/^\xff\x0a/],
    dec: () => instantiateEmscriptenWasm(jxlDec, jxlDecWasm),
    enc: () => instantiateEmscriptenWasm(jxlEnc, jxlEncWasm),
    defaultEncoderOptions: {
      speed: 4,
      quality: 75,
      progressive: false,
      epf: -1,
      nearLossless: 0,
      lossyPalette: false,
    },
    autoOptimize: {
      option: 'quality',
      min: 0,
      max: 100,
    },
  },
  wp2: {
    name: 'WebP2',
    extension: 'wp2',
    detectors: [/^\xF4\xFF\x6F/],
    dec: () => instantiateEmscriptenWasm(wp2Dec, wp2DecWasm),
    enc: () => instantiateEmscriptenWasm(wp2Enc, wp2EncWasm),
    defaultEncoderOptions: {
      quality: 75,
      alpha_quality: 75,
      effort: 5,
      pass: 1,
      sns: 50,
      uv_mode: 0 /*UVMode.UVModeAuto*/,
      csp_type: 0 /*Csp.kYCoCg*/,
      error_diffusion: 0,
      use_random_matrix: false,
    },
    autoOptimize: {
      option: 'quality',
      min: 0,
      max: 100,
    },
  },
  oxipng: {
    name: 'OxiPNG',
    extension: 'png',
    detectors: [/^\x89PNG\x0D\x0A\x1A\x0A/],
    dec: async () => {
      await pngEncDecPromise;
      return { decode: pngEncDec.decode };
    },
    enc: async () => {
      await pngEncDecPromise;
      await oxipngPromise;
      return {
        encode: (buffer, width, height, opts) => {
          const simplePng = pngEncDec.encode(
            new Uint8Array(buffer),
            width,
            height,
          );
          return oxipng.optimise(simplePng, opts.level);
        },
      };
    },
    defaultEncoderOptions: {
      level: 2,
    },
    autoOptimize: {
      option: 'level',
      min: 6,
      max: 1,
    },
  },
};
