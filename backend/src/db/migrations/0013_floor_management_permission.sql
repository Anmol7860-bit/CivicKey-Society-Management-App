-- The permission now covers floors as records of their own, so its description says so.
UPDATE "permissions" SET "description" = 'Manage society, blocks, floors and flats' WHERE "code" = 'SOCIETY_MANAGE';
