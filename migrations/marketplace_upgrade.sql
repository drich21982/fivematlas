ALTER TABLE trusted_sources ADD COLUMN IF NOT EXISTS is_verified BOOLEAN DEFAULT false;
ALTER TABLE indexed_assets ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'na';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS image_url TEXT;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'na';

UPDATE trusted_sources
SET is_verified = true
WHERE LOWER(domain) IN ('redsaintmods.com', 'redneckmods.com')
   OR LOWER(name) LIKE '%redsaint%'
   OR LOWER(name) LIKE '%redneck%';
