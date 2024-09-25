import {FeatureIndex} from '../data/feature_index';
import {OverscaledTileID} from './tile_id';

import type {IActor} from '../util/actor';
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

        const featureIndex = new FeatureIndex(this.tileID, this.promoteId);
        featureIndex.bucketLayerIDs = [];

        this.inFlightDependencies.forEach((request) => request?.abort());
        this.inFlightDependencies = [];

        this.status = 'done';
        return {
            featureIndex,
        };
    }
}
