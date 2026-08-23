import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

const lifecycleModels = [
  'Channel',
  'ChannelKey',
  'PublicModel',
  'ChannelModel',
  'ChannelModelCostRule',
  'ModelPriceVersion',
] as const;

describe('catalog lifecycle schema', () => {
  it.each(lifecycleModels)('%s exposes an optional deletedAt timestamp', (modelName) => {
    const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === modelName);
    const deletedAt = model?.fields.find((field) => field.name === 'deletedAt');

    expect(model, `${modelName} must exist in the generated Prisma client`).toBeDefined();
    expect(deletedAt, `${modelName}.deletedAt must exist`).toMatchObject({
      kind: 'scalar',
      type: 'DateTime',
      isRequired: false,
      isList: false,
    });
  });

  it('PublicModel exposes normalized manufacturer metadata', () => {
    const model = Prisma.dmmf.datamodel.models.find((candidate) => candidate.name === 'PublicModel');

    expect(model?.fields.find((field) => field.name === 'manufacturer')).toMatchObject({
      kind: 'scalar',
      type: 'String',
      isRequired: true,
      isList: false,
    });
    expect(model?.fields.find((field) => field.name === 'manufacturerKey')).toMatchObject({
      kind: 'scalar',
      type: 'String',
      isRequired: true,
      isList: false,
    });
  });
});
