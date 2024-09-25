import {FeatureIndex} from '../data/feature_index';
import {CollisionBoxArray} from '../data/array_types.g';
import {DictionaryCoder} from '../util/dictionary_coder';
import {warnOnce} from '../util/util';
import {EvaluationParameters} from '../style/evaluation_parameters';
import {OverscaledTileID} from './tile_id';

import type {IActor} from '../util/actor';
import type {StyleLayer} from '../style/style_layer';
import type {StyleLayerIndex} from '../style/style_layer_index';
import type {
    WorkerTileParameters,
    WorkerTileResult,
} from '../source/worker_source';
import type {PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';
import type {VectorTile} from '@mapbox/vector-tile';

export class WorkerTile {
    tileID: OverscaledTileID;
    uid: string | number;
    zoom: number;
    pixelRatio: number;
    tileSize: number;
    source: string;
    promoteId: PromoteIdSpecification;
    overscaling: number;
    showCollisionBoxes: boolean;
    collectResourceTiming: boolean;
    returnDependencies: boolean;

    status: 'parsing' | 'done';
    data: VectorTile;
    collisionBoxArray: CollisionBoxArray;

    abort: AbortController;
    vectorTile: VectorTile;
    inFlightDependencies: AbortController[];

    constructor(params: WorkerTileParameters) {
        this.tileID = new OverscaledTileID(params.tileID.overscaledZ, params.tileID.wrap, params.tileID.canonical.z, params.tileID.canonical.x, params.tileID.canonical.y);
        this.uid = params.uid;
        this.zoom = params.zoom;
        this.pixelRatio = params.pixelRatio;
        this.tileSize = params.tileSize;
        this.source = params.source;
        this.overscaling = this.tileID.overscaleFactor();
        this.showCollisionBoxes = params.showCollisionBoxes;
        this.collectResourceTiming = !!params.collectResourceTiming;
        this.returnDependencies = !!params.returnDependencies;
        this.promoteId = params.promoteId;
        this.inFlightDependencies = [];
    }

    async parse(data: VectorTile, layerIndex: StyleLayerIndex, availableImages: Array<string>, actor: IActor): Promise<WorkerTileResult> {
        this.status = 'parsing';
        this.data = data;

        this.collisionBoxArray = new CollisionBoxArray();
        const sourceLayerCoder = new DictionaryCoder(Object.keys(data.layers).sort());

        const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];

        const options = {
            featureIndex,
            iconDependencies: {},
            patternDependencies: {},
            glyphDependencies: {},
            availableImages
        };

        const layerFamilies = layerIndex.familiesBySource[this.source];
        for (const sourceLayerId in layerFamilies) {
            const sourceLayer = data.layers[sourceLayerId];
            if (!sourceLayer) {
                continue;
            }

            if (sourceLayer.version === 1) {
                warnOnce(`Vector tile source "${this.source}" layer "${sourceLayerId}" ` +
                    'does not use vector tile spec v2 and therefore may have some rendering errors.');
            }

            const sourceLayerIndex = sourceLayerCoder.encode(sourceLayerId);
            const features = [];
            for (let index = 0; index < sourceLayer.length; index++) {
                const feature = sourceLayer.feature(index);
                const id = featureIndex.getId(feature, sourceLayerId);
                features.push({feature, id, index, sourceLayerIndex});
            }

            for (const family of layerFamilies[sourceLayerId]) {
                const layer = family[0];

                if (layer.source !== this.source) {
                    warnOnce(`layer.source = ${layer.source} does not equal this.source = ${this.source}`);
                }
                if (layer.minzoom && this.zoom < Math.floor(layer.minzoom)) continue;
                if (layer.maxzoom && this.zoom >= layer.maxzoom) continue;
                if (layer.visibility === 'none') continue;

                recalculateLayers(family, this.zoom, availableImages);

                featureIndex.bucketLayerIDs.push(family.map((l) => l.id));
            }
        }

        this.inFlightDependencies.forEach((request) => request?.abort());
        this.inFlightDependencies = [];

        this.status = 'done';
        return {
            featureIndex,
            collisionBoxArray: this.collisionBoxArray,
        };
    }
}

function recalculateLayers(layers: ReadonlyArray<StyleLayer>, zoom: number, availableImages: Array<string>) {
    // Layers are shared and may have been used by a WorkerTile with a different zoom.
    const parameters = new EvaluationParameters(zoom);
    for (const layer of layers) {
        layer.recalculate(parameters, availableImages);
    }
}
