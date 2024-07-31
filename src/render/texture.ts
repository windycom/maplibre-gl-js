import type {Context} from '../gl/context';
import type {RGBAImage, AlphaImage} from '../util/image';
import {extend, isImageBitmap} from '../util/util';

export type TextureFormatWebGL2 = WebGL2RenderingContextBase['RG8'] | WebGL2RenderingContextBase['R8']
export type TextureFormat = WebGLRenderingContextBase['RGBA'] |WebGLRenderingContextBase['RGB'] | WebGLRenderingContextBase['ALPHA'] | WebGLRenderingContextBase['LUMINANCE'] | TextureFormatWebGL2;
export type TextureFilter = WebGLRenderingContextBase['LINEAR'] | WebGLRenderingContextBase['LINEAR_MIPMAP_NEAREST'] | WebGLRenderingContextBase['NEAREST'];
export type TextureWrap = WebGLRenderingContextBase['REPEAT'] | WebGLRenderingContextBase['CLAMP_TO_EDGE'] | WebGLRenderingContextBase['MIRRORED_REPEAT'];

type EmptyImage = {
    width: number;
    height: number;
    data: null;
};

type DataTextureImage = RGBAImage | AlphaImage | EmptyImage;
export type TextureImage = TexImageSource | DataTextureImage;

/**
 * @internal
 * A `Texture` GL related object
 */
export class Texture {
    context: Context;
    size: [number, number];
    texture: WebGLTexture;
    format: TextureFormat;
    filter: TextureFilter;
    wrap: TextureWrap;
    useMipmap: boolean;

    constructor(context: Context, image: TextureImage, format: TextureFormat, options?: {
        premultiply?: boolean;
        useMipmap?: boolean;
    } | null) {
        this.context = context;
        this.format = format;
        this.texture = context.gl.createTexture();

        // Pass format to the update method to enforce its usage
        this.update(image, extend(options, {format}));
    }

    /**
     * @summary Updates texture content, can also change texture format if necessary
     */
    update(image: TextureImage, options?: {
        premultiply?: boolean;
        useMipmap?: boolean;
        format?:TextureFormat;
    } | null, position?: {
        x: number;
        y: number;
    }) {
        const {width, height} = image as {width: number; height: number};
        const resize = (!this.size || this.size[0] !== width || this.size[1] !== height) && !position;
        const {context} = this;
        const {gl} = context;

        this.useMipmap = Boolean(options && options.useMipmap);

        // Use default maplibre format gl.RGBA to remain compatible with all users of the Texture class
        const newFormat = options && options.format ? options.format : gl.RGBA;
        const formatChanged = this.format !== newFormat;
        this.format = newFormat;

        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        context.pixelStoreUnpackFlipY.set(false);
        context.pixelStoreUnpack.set(1);
        context.pixelStoreUnpackPremultiplyAlpha.set(this.format === gl.RGBA && (!options || options.premultiply !== false));

        // Since internal-format and format can be represented by different values (e.g. gl.RG8 vs gl.RG) in WebGL2, we need to preform conversion
        const format = this.textureFormatFromInternalFormat(this.format);

        if (resize || formatChanged) {
            this.size = [width, height];

            if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement || image instanceof HTMLVideoElement || image instanceof ImageData || isImageBitmap(image)) {
                gl.texImage2D(gl.TEXTURE_2D, 0, this.format, format, gl.UNSIGNED_BYTE, image);
            } else {
                gl.texImage2D(gl.TEXTURE_2D, 0, this.format, width, height, 0, format, gl.UNSIGNED_BYTE, (image as DataTextureImage).data);
            }

        } else {
            const {x, y} = position || {x: 0, y: 0};
            if (image instanceof HTMLImageElement || image instanceof HTMLCanvasElement || image instanceof HTMLVideoElement || image instanceof ImageData || isImageBitmap(image)) {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, format, gl.UNSIGNED_BYTE, image);
            } else {
                gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, width, height, format, gl.UNSIGNED_BYTE, (image as DataTextureImage).data);
            }
        }

        if (this.useMipmap && this.isSizePowerOfTwo()) {
            gl.generateMipmap(gl.TEXTURE_2D);
        }
    }

    bind(filter: TextureFilter, wrap: TextureWrap, minFilter?: TextureFilter | null) {
        const {context} = this;
        const {gl} = context;
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        if (minFilter === gl.LINEAR_MIPMAP_NEAREST && !this.isSizePowerOfTwo()) {
            minFilter = gl.LINEAR;
        }

        if (filter !== this.filter) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, minFilter || filter);
            this.filter = filter;
        }

        if (wrap !== this.wrap) {
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
            this.wrap = wrap;
        }
    }

    isSizePowerOfTwo() {
        return this.size[0] === this.size[1] && (Math.log(this.size[0]) / Math.LN2) % 1 === 0;
    }

    destroy() {
        const {gl} = this.context;
        gl.deleteTexture(this.texture);
        this.texture = null;
    }

    /**
     * @summary Method for accessing texture format by its internal format for cases, when these two are not the same
     *  - specifically for special WebGL2 formats
     */
    textureFormatFromInternalFormat(internalFormat: TextureFormat) {
        let format: GLenum = internalFormat;
        switch (internalFormat) {
            case WebGL2RenderingContext['RG8']:
                format = WebGL2RenderingContext['RG'];
                break;
            case WebGL2RenderingContext['R8']:
                format = WebGL2RenderingContext['RED'];
                break;
        }
        return format;
    }
}
