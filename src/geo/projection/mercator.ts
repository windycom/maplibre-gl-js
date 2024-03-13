import {mat4} from 'gl-matrix';
import {Painter} from '../../render/painter';
import {Transform} from '../transform';
import {ProjectionBase} from './projection_base';
import {UnwrappedTileID} from '../../source/tile_id';
import Point from '@mapbox/point-geometry';
import {Tile} from '../../source/tile';
import {ProjectionData} from '../../render/program/projection_program';
import {pixelsToTileUnits} from '../../source/pixels_to_tile_units';
import {EXTENT} from '../../data/extent';
import {PreparedShader, shaders} from '../../shaders/shaders';

export const MercatorShaderDefine = '#define PROJECTION_MERCATOR';
export const MercatorShaderVariantKey = 'mercator';

export class MercatorProjection implements ProjectionBase {
    get name(): string {
        return 'mercator';
    }

    get useSpecialProjectionForSymbols(): boolean {
        return false;
    }

    get isRenderingDirty(): boolean {
        // Mercator projection does no animations of its own, so rendering is never dirty from its perspective.
        return false;
    }

    get drawWrappedTiles(): boolean {
        // Mercator always needs to draw wrapped/duplicated tiles.
        return true;
    }

    get shaderVariantName(): string {
        return MercatorShaderVariantKey;
    }

    get shaderDefine(): string {
        return MercatorShaderDefine;
    }

    get shaderPreludeCode(): PreparedShader {
        return shaders.projectionMercator;
    }

    get vertexShaderPreludeCode(): string {
        return shaders.projectionMercator.vertexSource;
    }

    destroy(): void {
        // Do nothing.
    }

    updateGPUdependent(_: Painter): void {
        // Do nothing.
    }

    updateProjection(_: Transform): void {
        // Do nothing.
    }

    getProjectionData(canonicalTileCoords: {x: number; y: number; z: number}, tilePosMatrix: mat4): ProjectionData {
        let tileOffsetSize: [number, number, number, number];

        if (canonicalTileCoords) {
            const scale = (canonicalTileCoords.z >= 0) ? (1 << canonicalTileCoords.z) : Math.pow(2.0, canonicalTileCoords.z);
            tileOffsetSize = [
                canonicalTileCoords.x / scale,
                canonicalTileCoords.y / scale,
                1.0 / scale / EXTENT,
                1.0 / scale / EXTENT
            ];
        } else {
            tileOffsetSize = [0, 0, 1, 1];
        }
        const mainMatrix = tilePosMatrix ? tilePosMatrix : mat4.create();

        const data: ProjectionData = {
            'u_projection_matrix': mainMatrix, // Might be set to a custom matrix by different projections
            'u_projection_tile_mercator_coords': tileOffsetSize,
            'u_projection_clipping_plane': [0, 0, 0, 0],
            'u_projection_transition': 0.0,
            'u_projection_fallback_matrix': mainMatrix,
        };

        return data;
    }

    isOccluded(_: number, __: number, ___: UnwrappedTileID): boolean {
        return false;
    }

    project(_x: number, _y: number, _unwrappedTileID: UnwrappedTileID): {
        point: Point;
        signedDistanceFromCamera: number;
        isOccluded: boolean;
    } {
        // This function should only be used when useSpecialProjectionForSymbols is set to true.
        throw new Error('Not implemented.');
    }

    getPixelScale(_: Transform): number {
        return 1.0;
    }

    translatePosition(transform: Transform, tile: Tile, translate: [number, number], translateAnchor: 'map' | 'viewport'): [number, number] {
        return translatePosition(transform, tile, translate, translateAnchor);
    }
}

/**
 * Transform a matrix to incorporate the *-translate and *-translate-anchor properties into it.
 * @param inViewportPixelUnitsUnits - True when the units accepted by the matrix are in viewport pixels instead of tile units.
 * @returns matrix
 */
export function translatePosMatrix(
    transform: Transform,
    tile: Tile,
    matrix: mat4,
    translate: [number, number],
    translateAnchor: 'map' | 'viewport',
    inViewportPixelUnitsUnits: boolean = false
): mat4 {
    if (!translate[0] && !translate[1]) return matrix;

    const translation = translatePosition(transform, tile, translate, translateAnchor, inViewportPixelUnitsUnits);
    const translatedMatrix = new Float32Array(16);
    mat4.translate(translatedMatrix, matrix, [translation[0], translation[1], 0]);
    return translatedMatrix;
}

/**
 * Returns a translation in tile units that correctly incorporates the view angle and the *-translate and *-translate-anchor properties.
 * @param inViewportPixelUnitsUnits - True when the units accepted by the matrix are in viewport pixels instead of tile units.
 */
export function translatePosition(
    transform: Transform,
    tile: Tile,
    translate: [number, number],
    translateAnchor: 'map' | 'viewport',
    inViewportPixelUnitsUnits: boolean = false
): [number, number] {
    if (!translate[0] && !translate[1]) return [0, 0];

    const angle = inViewportPixelUnitsUnits ?
        (translateAnchor === 'map' ? transform.angle : 0) :
        (translateAnchor === 'viewport' ? -transform.angle : 0);

    if (angle) {
        const sinA = Math.sin(angle);
        const cosA = Math.cos(angle);
        translate = [
            translate[0] * cosA - translate[1] * sinA,
            translate[0] * sinA + translate[1] * cosA
        ];
    }

    return [
        inViewportPixelUnitsUnits ? translate[0] : pixelsToTileUnits(tile, translate[0], transform.zoom),
        inViewportPixelUnitsUnits ? translate[1] : pixelsToTileUnits(tile, translate[1], transform.zoom)];
}