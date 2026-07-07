-- 0034_geofence_category.sql
-- Category-based geofence classification: capture the Motive telematics geofence `category`
-- (e.g. "Recycling", "Transfer Station", "Donation", "Job Site", "Uncategorized") so facility
-- classification no longer depends on fragile geofence-name↔settings-site-name matching.
alter table public.geofence_alerts   add column if not exists category text;
alter table public.motive_geofences  add column if not exists category text;
