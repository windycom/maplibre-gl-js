import {Actor, ActorTarget, IActor} from '../util/actor';
import {StyleLayerIndex} from '../style/style_layer_index';
import {isWorker} from '../util/util';
import {addProtocol, removeProtocol} from './protocol_crud';
import type {
    WorkerSource,
    WorkerSourceConstructor,
    WorkerTileParameters,
    TileParameters
} from '../source/worker_source';

import type {WorkerGlobalScopeInterface} from '../util/web_worker';
import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';
import {
    MessageType,
    type RemoveSourceParams,
    type UpdateLayersParamaeters
} from '../util/actor_messages';

/**
 * The Worker class responsible for background thread related execution
 */
export default class Worker {
    self: WorkerGlobalScopeInterface & ActorTarget;
    actor: Actor;
    layerIndexes: {[_: string]: StyleLayerIndex};
    availableImages: {[_: string]: Array<string>};
    externalWorkerSourceTypes: { [_: string]: WorkerSourceConstructor };
    /**
     * This holds a cache for the already created worker source instances.
     * The cache is build with the following hierarchy:
     * [mapId][sourceType][sourceName]: worker source instance
     * sourceType can be 'vector' for example
     */
    workerSources: {
        [_: string]: {
            [_: string]: {
                [_: string]: WorkerSource;
            };
        };
    };
    referrer: string;

    constructor(self: WorkerGlobalScopeInterface & ActorTarget) {
        this.self = self;
        this.actor = new Actor(self);

        this.layerIndexes = {};
        this.availableImages = {};

        this.workerSources = {};
        this.externalWorkerSourceTypes = {};

        this.self.registerWorkerSource = (name: string, WorkerSource: WorkerSourceConstructor) => {
            if (this.externalWorkerSourceTypes[name]) {
                throw new Error(`Worker source with name "${name}" already registered.`);
            }
            this.externalWorkerSourceTypes[name] = WorkerSource;
        };

        this.self.addProtocol = addProtocol;
        this.self.removeProtocol = removeProtocol;

        this.actor.registerMessageHandler(MessageType.loadTile, (mapId: string, params: WorkerTileParameters) => {
            return this._getWorkerSource(mapId, params.type, params.source).loadTile(params);
        });

        this.actor.registerMessageHandler(MessageType.reloadTile, (mapId: string, params: WorkerTileParameters) => {
            return this._getWorkerSource(mapId, params.type, params.source).reloadTile(params);
        });

        this.actor.registerMessageHandler(MessageType.abortTile, (mapId: string, params: TileParameters) => {
            return this._getWorkerSource(mapId, params.type, params.source).abortTile(params);
        });

        this.actor.registerMessageHandler(MessageType.removeTile, (mapId: string, params: TileParameters) => {
            return this._getWorkerSource(mapId, params.type, params.source).removeTile(params);
        });

        this.actor.registerMessageHandler(MessageType.removeSource, async (mapId: string, params: RemoveSourceParams) => {
            if (!this.workerSources[mapId] ||
                !this.workerSources[mapId][params.type] ||
                !this.workerSources[mapId][params.type][params.source]) {
                return;
            }

            const worker = this.workerSources[mapId][params.type][params.source];
            delete this.workerSources[mapId][params.type][params.source];

            if (worker.removeSource !== undefined) {
                worker.removeSource(params);
            }
        });

        this.actor.registerMessageHandler(MessageType.removeMap, async (mapId: string) => {
            delete this.layerIndexes[mapId];
            delete this.availableImages[mapId];
            delete this.workerSources[mapId];
        });

        this.actor.registerMessageHandler(MessageType.setReferrer, async (_mapId: string, params: string) => {
            this.referrer = params;
        });

        this.actor.registerMessageHandler(MessageType.importScript, async (_mapId: string, params: string) => {
            this.self.importScripts(params);
        });

        this.actor.registerMessageHandler(MessageType.setImages, (mapId: string, params: string[]) => {
            return this._setImages(mapId, params);
        });

        this.actor.registerMessageHandler(MessageType.updateLayers, async (mapId: string, params: UpdateLayersParamaeters) => {
            this._getLayerIndex(mapId).update(params.layers, params.removedIds);
        });

        this.actor.registerMessageHandler(MessageType.setLayers, async (mapId: string, params: Array<LayerSpecification>) => {
            this._getLayerIndex(mapId).replace(params);
        });
    }

    private async _setImages(mapId: string, images: Array<string>): Promise<void> {
        this.availableImages[mapId] = images;
        for (const workerSource in this.workerSources[mapId]) {
            const ws = this.workerSources[mapId][workerSource];
            for (const source in ws) {
                ws[source].availableImages = images;
            }
        }
    }

    private _getAvailableImages(mapId: string) {
        let availableImages = this.availableImages[mapId];

        if (!availableImages) {
            availableImages = [];
        }

        return availableImages;
    }

    private _getLayerIndex(mapId: string) {
        let layerIndexes = this.layerIndexes[mapId];
        if (!layerIndexes) {
            layerIndexes = this.layerIndexes[mapId] = new StyleLayerIndex();
        }
        return layerIndexes;
    }

    /**
     * This is basically a lazy initialization of a worker per mapId and sourceType and sourceName
     * @param mapId - the mapId
     * @param sourceType - the source type - 'vector' for example
     * @param sourceName - the source name - 'osm' for example
     * @returns a new instance or a cached one
     */
    private _getWorkerSource(mapId: string, sourceType: string, sourceName: string): WorkerSource {
        if (!this.workerSources[mapId])
            this.workerSources[mapId] = {};
        if (!this.workerSources[mapId][sourceType])
            this.workerSources[mapId][sourceType] = {};

        if (!this.workerSources[mapId][sourceType][sourceName]) {
            // use a wrapped actor so that we can attach a target mapId param
            // to any messages invoked by the WorkerSource, this is very important when there are multiple maps
            const actor: IActor = {
                sendAsync: (message, abortController) => {
                    message.targetMapId = mapId;
                    return this.actor.sendAsync(message, abortController);
                }
            };
            switch (sourceType) {
                default:
                    this.workerSources[mapId][sourceType][sourceName] = new (this.externalWorkerSourceTypes[sourceType])(actor, this._getLayerIndex(mapId), this._getAvailableImages(mapId));
                    break;
            }
        }

        return this.workerSources[mapId][sourceType][sourceName];
    }
}

if (isWorker(self)) {
    self.worker = new Worker(self);
}
