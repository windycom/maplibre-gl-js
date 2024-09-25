import {StyleLayer} from './style_layer';
import {createStyleLayer} from './create_style_layer';

import {featureFilter} from '@maplibre/maplibre-gl-style-spec';

import type {LayerSpecification} from '@maplibre/maplibre-gl-style-spec';

export type LayerConfigs = {[_: string]: LayerSpecification};

export class StyleLayerIndex {
    keyCache: {[source: string]: string};

    _layerConfigs: LayerConfigs;
    _layers: {[_: string]: StyleLayer};

    constructor(layerConfigs?: Array<LayerSpecification> | null) {
        this.keyCache = {};
        if (layerConfigs) {
            this.replace(layerConfigs);
        }
    }

    replace(layerConfigs: Array<LayerSpecification>) {
        this._layerConfigs = {};
        this._layers = {};
        this.update(layerConfigs, []);
    }

    update(layerConfigs: Array<LayerSpecification>, removedIds: Array<string>) {
        for (const layerConfig of layerConfigs) {
            this._layerConfigs[layerConfig.id] = layerConfig;

            const layer = this._layers[layerConfig.id] = createStyleLayer(layerConfig);
            layer._featureFilter = featureFilter(layer.filter);
            if (this.keyCache[layerConfig.id])
                delete this.keyCache[layerConfig.id];
        }
        for (const id of removedIds) {
            delete this.keyCache[id];
            delete this._layerConfigs[id];
            delete this._layers[id];
        }
    }
}
