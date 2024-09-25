import {ProjectionSpecification} from '@maplibre/maplibre-gl-style-spec';
import {warnOnce} from '../../util/util';
import {Projection} from './projection';
import {ITransform} from '../transform_interface';
import {ICameraHelper} from './camera_helper';
import {MercatorProjection} from './mercator';
import {MercatorTransform} from './mercator_transform';
import {MercatorCameraHelper} from './mercator_camera_helper';

export function createProjectionFromName(name: ProjectionSpecification['type']): {
    projection: Projection;
    transform: ITransform;
    cameraHelper: ICameraHelper;
} {
    switch (name) {
        case 'mercator':
        {
            return {
                projection: new MercatorProjection(),
                transform: new MercatorTransform(),
                cameraHelper: new MercatorCameraHelper(),
            };
        }
        default:
        {
            warnOnce(`Unknown projection name: ${name}. Falling back to mercator projection.`);
            return {
                projection: new MercatorProjection(),
                transform: new MercatorTransform(),
                cameraHelper: new MercatorCameraHelper(),
            };
        }
    }
}
