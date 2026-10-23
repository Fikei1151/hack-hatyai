-- More kinds of important places: banks, fuel stations, convenience stores and communities
-- (villages / neighbourhoods) alongside hospitals, schools, temples, markets and the rest.
alter table public.places drop constraint places_category_check;
alter table public.places add constraint places_category_check
  check (category in ('health', 'education', 'religion', 'market', 'shop', 'emergency', 'government', 'transport', 'lodging', 'landmark', 'shelter', 'finance', 'fuel', 'community'));
