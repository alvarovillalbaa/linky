-- Populates the exact empty Supabase 2.122.0 scaffold generated in CI.
-- Requires db/bootstrap.sql, applied only by the separately approved operator.
BEGIN;
SET LOCAL ROLE linky_function_owner;
SET LOCAL search_path = '';

CREATE TABLE linky_private.workspaces (
  id uuid PRIMARY KEY, name varchar(160) NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(name)) > 0),
  owner_key_hash text NOT NULL UNIQUE CHECK (owner_key_hash ~ '^[0-9a-f]{64}$'),
  owner_key_version bigint NOT NULL DEFAULT 1 CHECK (owner_key_version BETWEEN 1 AND 9007199254740991),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','closed')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL, closed_at timestamptz,
  CHECK ((state = 'closed') = (closed_at IS NOT NULL))
);
CREATE TABLE linky_private.links (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES linky_private.workspaces(id),
  slug varchar(96) NOT NULL UNIQUE CHECK (slug ~ '^[A-Za-z0-9_-]{8,96}$'),
  label varchar(200) NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(label)) > 0),
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active','paused','blocked')),
  version bigint NOT NULL DEFAULT 1 CHECK (version BETWEEN 1 AND 9007199254740991),
  current_revision_id uuid NOT NULL, created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  UNIQUE (workspace_id,id)
);
CREATE INDEX links_owner_list ON linky_private.links(workspace_id,state,id);
CREATE TABLE linky_private.destination_revisions (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL,
  revision_number bigint NOT NULL CHECK (revision_number > 0), destination_url varchar(2048) NOT NULL,
  destination_sha256 text NOT NULL CHECK (destination_sha256 ~ '^[0-9a-f]{64}$'),
  campaign_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(campaign_snapshot) = 'object' AND pg_catalog.pg_column_size(campaign_snapshot) <= 4096
    AND campaign_snapshot ?& ARRAY['source','medium','campaign'] AND campaign_snapshot - ARRAY['source','medium','campaign'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'source') = 'string' AND pg_catalog.length(campaign_snapshot->>'source') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'medium') = 'string' AND pg_catalog.length(campaign_snapshot->>'medium') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'campaign') = 'string' AND pg_catalog.length(campaign_snapshot->>'campaign') <= 100),
  safety_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(safety_snapshot) = 'object' AND pg_catalog.pg_column_size(safety_snapshot) <= 4096
    AND safety_snapshot ?& ARRAY['policyVersion','hostname','result','reputation'] AND safety_snapshot - ARRAY['policyVersion','hostname','result','reputation'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(safety_snapshot->'policyVersion') = 'string' AND pg_catalog.jsonb_typeof(safety_snapshot->'result') = 'string' AND pg_catalog.jsonb_typeof(safety_snapshot->'reputation') = 'string'
    AND safety_snapshot->>'policyVersion' = 'linky-address-v1' AND safety_snapshot->>'result' IN ('accepted','review') AND safety_snapshot->>'reputation' = 'unchecked'
    AND pg_catalog.jsonb_typeof(safety_snapshot->'hostname') = 'string' AND pg_catalog.length(safety_snapshot->>'hostname') BETWEEN 1 AND 253),
  created_at timestamptz NOT NULL,
  UNIQUE (workspace_id,link_id,id), UNIQUE (workspace_id,link_id,revision_number),
  FOREIGN KEY (workspace_id,link_id) REFERENCES linky_private.links(workspace_id,id) DEFERRABLE INITIALLY DEFERRED
);
ALTER TABLE linky_private.links ADD CONSTRAINT links_current_revision FOREIGN KEY (workspace_id,id,current_revision_id)
  REFERENCES linky_private.destination_revisions(workspace_id,link_id,id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE linky_private.grants (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  recipient_key_hash text NOT NULL UNIQUE CHECK (recipient_key_hash ~ '^[0-9a-f]{64}$'),
  label varchar(200) NOT NULL, max_uses integer NOT NULL CHECK (max_uses BETWEEN 1 AND 1000000),
  used_count integer NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= max_uses),
  expires_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(expires_at)), revoked_at timestamptz,
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at)), CHECK (expires_at > created_at),
  UNIQUE (workspace_id,link_id,revision_id,id),
  FOREIGN KEY (workspace_id,link_id,revision_id) REFERENCES linky_private.destination_revisions(workspace_id,link_id,id)
);
CREATE INDEX grants_owner_list ON linky_private.grants(workspace_id,link_id,id);
CREATE TABLE linky_private.redemption_receipts (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL, grant_id uuid NOT NULL,
  redemption_key uuid NOT NULL, request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  use_number integer NOT NULL CHECK (use_number > 0), destination_sha256 text NOT NULL CHECK (destination_sha256 ~ '^[0-9a-f]{64}$'),
  campaign_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(campaign_snapshot) = 'object' AND pg_catalog.pg_column_size(campaign_snapshot) <= 4096
    AND campaign_snapshot ?& ARRAY['source','medium','campaign'] AND campaign_snapshot - ARRAY['source','medium','campaign'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'source') = 'string' AND pg_catalog.length(campaign_snapshot->>'source') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'medium') = 'string' AND pg_catalog.length(campaign_snapshot->>'medium') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'campaign') = 'string' AND pg_catalog.length(campaign_snapshot->>'campaign') <= 100),
  redeemed_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(redeemed_at)),
  UNIQUE (grant_id,redemption_key), UNIQUE (grant_id,use_number), UNIQUE (workspace_id,link_id,revision_id,id),
  FOREIGN KEY (workspace_id,link_id,revision_id,grant_id) REFERENCES linky_private.grants(workspace_id,link_id,revision_id,id)
);
CREATE INDEX receipts_report ON linky_private.redemption_receipts(workspace_id,redeemed_at,id);
CREATE TABLE linky_private.attribution_events (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  receipt_id uuid NOT NULL UNIQUE, kind text NOT NULL CHECK (kind = 'redemption_committed'),
  campaign_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(campaign_snapshot) = 'object' AND pg_catalog.pg_column_size(campaign_snapshot) <= 4096
    AND campaign_snapshot ?& ARRAY['source','medium','campaign'] AND campaign_snapshot - ARRAY['source','medium','campaign'] = '{}'::jsonb
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'source') = 'string' AND pg_catalog.length(campaign_snapshot->>'source') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'medium') = 'string' AND pg_catalog.length(campaign_snapshot->>'medium') <= 100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'campaign') = 'string' AND pg_catalog.length(campaign_snapshot->>'campaign') <= 100),
  observed_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(observed_at)),
  FOREIGN KEY (workspace_id,link_id,revision_id,receipt_id) REFERENCES linky_private.redemption_receipts(workspace_id,link_id,revision_id,id)
);
CREATE INDEX attribution_report ON linky_private.attribution_events(workspace_id,observed_at,id);
CREATE TABLE linky_private.mutation_receipts (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES linky_private.workspaces(id),
  mutation_key uuid NOT NULL, operation text NOT NULL, resource_id uuid NOT NULL,
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  owner_key_version bigint NOT NULL, result_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(result_snapshot) = 'object' AND pg_catalog.pg_column_size(result_snapshot) <= 8192),
  created_at timestamptz NOT NULL, UNIQUE (workspace_id,mutation_key),
  CHECK (operation IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant'))
);
CREATE TABLE linky_private.audit_events (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), workspace_id uuid NOT NULL REFERENCES linky_private.workspaces(id),
  actor_kind text NOT NULL CHECK (actor_kind IN ('operator','owner','recipient')),
  actor_id uuid NOT NULL, owner_key_version bigint, action text NOT NULL, resource_kind text NOT NULL,
  resource_id uuid NOT NULL, before_version bigint, after_version bigint, occurred_at timestamptz NOT NULL,
  details jsonb NOT NULL CHECK (details = '{}'::jsonb),
  CHECK (action IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant','redeem')),
  CHECK (resource_kind IN ('workspace','link','grant'))
);
CREATE INDEX audit_owner_list ON linky_private.audit_events(workspace_id,occurred_at,id);

CREATE FUNCTION linky_private._fail(code text) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = 'P0001', MESSAGE = code; END $$;
CREATE FUNCTION linky_private._shape(value jsonb, required text[], optional text[] DEFAULT ARRAY[]::text[]) RETURNS void
LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF value IS NULL OR pg_catalog.jsonb_typeof(value) <> 'object' OR pg_catalog.pg_column_size(value) > 32768
     OR NOT (value ?& required) OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_object_keys(value) k WHERE NOT (k = ANY(required || optional)))
  THEN PERFORM linky_private._fail('linky_invalid'); END IF;
END $$;
CREATE FUNCTION linky_private._text(value jsonb, key text, maximum integer, empty_ok boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result text;
BEGIN
  IF pg_catalog.jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  result := value->>key;
  IF pg_catalog.length(result) > maximum OR result ~ '[[:cntrl:]]' OR result ~ 'ly[or]_[0-9a-f]{64}' OR (NOT empty_ok AND pg_catalog.length(pg_catalog.btrim(result)) = 0)
  THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result;
END $$;
CREATE FUNCTION linky_private._uuid(value jsonb, key text) RETURNS uuid LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result text;
BEGIN
  result := linky_private._text(value,key,36);
  IF result !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result::uuid;
END $$;
CREATE FUNCTION linky_private._integer(value jsonb,key text,minimum bigint,maximum bigint) RETURNS bigint
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result numeric;
BEGIN
  IF pg_catalog.jsonb_typeof(value->key) IS DISTINCT FROM 'number' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  result := (value->>key)::numeric;
  IF result <> pg_catalog.trunc(result) OR result < minimum OR result > maximum THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result::bigint;
END $$;
CREATE FUNCTION linky_private._hash(value text) RETURNS text LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF value IS NULL OR value !~ '^[0-9a-f]{64}$' THEN PERFORM linky_private._fail('linky_denied'); END IF;
  RETURN value;
END $$;
CREATE FUNCTION linky_private._sha(value text) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8')),'hex') $$;
CREATE FUNCTION linky_private._fingerprint(operation text,value jsonb) RETURNS text LANGUAGE sql IMMUTABLE SET search_path = ''
AS $$ SELECT linky_private._sha(operation || E'\n' || (value - 'mutationKey')::text) $$;
CREATE FUNCTION linky_private._instant(value jsonb,key text) RETURNS timestamptz LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result timestamptz; raw text;
BEGIN
  raw := linky_private._text(value,key,40);
  IF raw !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  BEGIN result := raw::timestamptz; EXCEPTION WHEN OTHERS THEN PERFORM linky_private._fail('linky_invalid'); END;
  IF NOT pg_catalog.isfinite(result) THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result;
END $$;
CREATE FUNCTION linky_private._revision(value jsonb) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE destination text; authority text; hostname text; ip inet; part text; result text := 'accepted';
BEGIN
  destination := linky_private._text(value,'destination',2048);
  IF destination !~ '^https?://' OR destination ~ '[[:space:]\\]' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  authority := pg_catalog.substring(destination, '^https?://([^/?#]+)');
  IF authority IS NULL OR authority <> pg_catalog.lower(authority) OR authority ~ '@' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  hostname := pg_catalog.regexp_replace(authority,'\.$','');
  IF authority ~ '^\[[0-9a-f:]+\]$' THEN
    BEGIN ip := pg_catalog.substr(authority,2,pg_catalog.length(authority)-2)::inet; EXCEPTION WHEN OTHERS THEN PERFORM linky_private._fail('linky_invalid'); END;
    IF NOT (ip <<= '2000::/3'::inet) OR ip <<= '2001::/23'::inet OR ip <<= '2001:db8::/32'::inet OR ip <<= '2002::/16'::inet OR ip <<= '3fff::/20'::inet THEN PERFORM linky_private._fail('linky_invalid'); END IF;
    result := 'review';
  ELSIF hostname ~ '^\d+\.\d+\.\d+\.\d+$' THEN
    BEGIN ip := hostname::inet; EXCEPTION WHEN OTHERS THEN PERFORM linky_private._fail('linky_invalid'); END;
    IF pg_catalog.host(ip) <> hostname OR EXISTS (SELECT 1 FROM pg_catalog.unnest(ARRAY['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','100.64.0.0/10','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','192.0.0.0/24','192.0.2.0/24','192.88.99.0/24','198.18.0.0/15','198.51.100.0/24','203.0.113.0/24','224.0.0.0/3']::inet[]) n WHERE ip <<= n) THEN PERFORM linky_private._fail('linky_invalid'); END IF;
    result := 'review';
  ELSE
    IF hostname !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
       OR pg_catalog.length(hostname) > 253 OR hostname ~ '(^|\.)(localhost|local|internal|home|lan|test|invalid|example|onion)$'
       OR hostname = 'home.arpa' OR hostname LIKE '%.home.arpa' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
    FOREACH part IN ARRAY pg_catalog.string_to_array(hostname,'.') LOOP
      IF pg_catalog.length(part) > 63 THEN PERFORM linky_private._fail('linky_invalid'); END IF;
    END LOOP;
    IF hostname ~ '(^|\.)xn--' THEN result := 'review'; END IF;
  END IF;
  IF destination LIKE 'http://%' THEN result := 'review'; END IF;
  PERFORM linky_private._shape(value->'campaign',ARRAY['source','medium','campaign']);
  PERFORM linky_private._text(value->'campaign','source',100,true), linky_private._text(value->'campaign','medium',100,true), linky_private._text(value->'campaign','campaign',100,true);
  PERFORM linky_private._shape(value->'safety',ARRAY['policyVersion','hostname','result','reputation']);
  IF value#>>'{safety,policyVersion}' IS DISTINCT FROM 'linky-address-v1' OR value#>>'{safety,hostname}' IS DISTINCT FROM hostname
     OR value#>>'{safety,result}' IS DISTINCT FROM result OR value#>>'{safety,reputation}' IS DISTINCT FROM 'unchecked'
  THEN PERFORM linky_private._fail('linky_invalid'); END IF;
END $$;
CREATE FUNCTION linky_private._owner(hash text,id uuid,exclusive_lock boolean DEFAULT false) RETURNS linky_private.workspaces
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE workspace linky_private.workspaces;
BEGIN
  PERFORM linky_private._hash(hash);
  IF exclusive_lock THEN SELECT * INTO workspace FROM linky_private.workspaces w WHERE w.id = _owner.id FOR UPDATE;
  ELSE SELECT * INTO workspace FROM linky_private.workspaces w WHERE w.id = _owner.id FOR SHARE; END IF;
  IF NOT FOUND OR workspace.owner_key_hash <> hash THEN PERFORM linky_private._fail('linky_denied'); END IF;
  IF workspace.state <> 'active' THEN PERFORM linky_private._fail('linky_closed'); END IF;
  RETURN workspace;
END $$;
CREATE FUNCTION linky_private._link(workspace uuid,id uuid,write_lock boolean DEFAULT true) RETURNS linky_private.links
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result linky_private.links;
BEGIN
  IF write_lock THEN SELECT * INTO result FROM linky_private.links l WHERE l.workspace_id = workspace AND l.id = _link.id FOR UPDATE;
  ELSE SELECT * INTO result FROM linky_private.links l WHERE l.workspace_id = workspace AND l.id = _link.id FOR SHARE; END IF;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  RETURN result;
END $$;
CREATE FUNCTION linky_private._replay(workspace uuid,key uuid,operation text,fingerprint text) RETURNS jsonb
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE receipt linky_private.mutation_receipts;
BEGIN
  SELECT * INTO receipt FROM linky_private.mutation_receipts r WHERE r.workspace_id = workspace AND r.mutation_key = key;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF receipt.operation <> operation OR receipt.request_fingerprint <> fingerprint THEN PERFORM linky_private._fail('linky_conflict'); END IF;
  RETURN receipt.result_snapshot || pg_catalog.jsonb_build_object('replayed',true);
END $$;
CREATE FUNCTION linky_private._audit(workspace uuid,actor text,actor_id uuid,key_version bigint,action text,resource text,resource_id uuid,before_version bigint,after_version bigint,at_time timestamptz)
RETURNS void LANGUAGE sql SET search_path = '' AS $$
  INSERT INTO linky_private.audit_events(workspace_id,actor_kind,actor_id,owner_key_version,action,resource_kind,resource_id,before_version,after_version,occurred_at,details)
  VALUES(workspace,actor,actor_id,key_version,action,resource,resource_id,before_version,after_version,at_time,'{}'::jsonb)
$$;
CREATE FUNCTION linky_private._finish(workspace uuid,key uuid,operation text,resource uuid,fingerprint text,key_version bigint,result jsonb,actor text,actor_id uuid,resource_kind text,before_version bigint,after_version bigint,at_time timestamptz)
RETURNS jsonb LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  INSERT INTO linky_private.mutation_receipts(workspace_id,mutation_key,operation,resource_id,request_fingerprint,owner_key_version,result_snapshot,created_at)
    VALUES(workspace,key,operation,resource,fingerprint,key_version,result,at_time);
  PERFORM linky_private._audit(workspace,actor,actor_id,key_version,operation,resource_kind,resource,before_version,after_version,at_time);
  RETURN result || pg_catalog.jsonb_build_object('replayed',false);
END $$;
CREATE FUNCTION linky_private._cas(actual bigint,expected bigint) RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN IF actual <> expected THEN PERFORM linky_private._fail('linky_conflict'); END IF; END $$;
CREATE FUNCTION linky_private._immutable() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN PERFORM linky_private._fail('linky_immutable'); RETURN NULL; END $$;
CREATE TRIGGER immutable_revisions BEFORE UPDATE OR DELETE ON linky_private.destination_revisions FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE TRIGGER immutable_receipts BEFORE UPDATE OR DELETE ON linky_private.redemption_receipts FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE TRIGGER immutable_attribution BEFORE UPDATE OR DELETE ON linky_private.attribution_events FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE TRIGGER immutable_mutations BEFORE UPDATE OR DELETE ON linky_private.mutation_receipts FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON linky_private.audit_events FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE FUNCTION linky_private._grant_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP = 'DELETE' OR (pg_catalog.to_jsonb(NEW) - ARRAY['used_count','revoked_at']) <> (pg_catalog.to_jsonb(OLD) - ARRAY['used_count','revoked_at'])
     OR NEW.used_count NOT IN (OLD.used_count,OLD.used_count+1) OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at)
  THEN PERFORM linky_private._fail('linky_immutable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER constrained_grants BEFORE UPDATE OR DELETE ON linky_private.grants FOR EACH ROW EXECUTE FUNCTION linky_private._grant_change();

CREATE FUNCTION linky_private.operator_provision(p_operator_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE workspace uuid; key uuid; fingerprint text; old jsonb; at_time timestamptz; label text; owner_hash text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','name','ownerHash']);
  workspace := linky_private._uuid(p_payload,'workspaceId'); key := linky_private._uuid(p_payload,'mutationKey');
  label := linky_private._text(p_payload,'name',160); owner_hash := linky_private._hash(linky_private._text(p_payload,'ownerHash',64));
  IF p_operator_id IS NULL THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  fingerprint := linky_private._fingerprint('provision',p_payload);
  -- A stable workspace advisory lock serializes first creation before a row exists.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(workspace::text,0));
  PERFORM 1 FROM linky_private.workspaces w WHERE w.id = workspace FOR UPDATE;
  old := linky_private._replay(workspace,key,'provision',fingerprint); IF old IS NOT NULL THEN RETURN old; END IF;
  IF EXISTS(SELECT 1 FROM linky_private.workspaces w WHERE w.id = workspace) THEN PERFORM linky_private._fail('linky_conflict'); END IF;
  at_time := pg_catalog.clock_timestamp();
  INSERT INTO linky_private.workspaces(id,name,owner_key_hash,created_at,updated_at) VALUES(workspace,label,owner_hash,at_time,at_time);
  RETURN linky_private._finish(workspace,key,'provision',workspace,fingerprint,1,pg_catalog.jsonb_build_object('workspaceId',workspace,'ownerKeyVersion',1,'state','active'),'operator',p_operator_id,'workspace',NULL,1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_connect(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE id uuid; workspace linky_private.workspaces;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY[]::text[]); PERFORM linky_private._hash(p_owner_hash);
  SELECT w.id INTO id FROM linky_private.workspaces w WHERE w.owner_key_hash = p_owner_hash;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_denied'); END IF;
  workspace := linky_private._owner(p_owner_hash,id);
  RETURN pg_catalog.jsonb_build_object('workspace',pg_catalog.jsonb_build_object('id',workspace.id,'name',workspace.name,'state',workspace.state,'ownerKeyVersion',workspace.owner_key_version));
END $$;
CREATE FUNCTION linky_private.owner_rotate(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; key uuid; fp text; old jsonb; at_time timestamptz; next_hash text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','newOwnerHash','expectedOwnerKeyVersion']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'),true);
  key := linky_private._uuid(p_payload,'mutationKey'); next_hash := linky_private._hash(linky_private._text(p_payload,'newOwnerHash',64)); fp := linky_private._fingerprint('rotate_owner',p_payload);
  old := linky_private._replay(w.id,key,'rotate_owner',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(w.owner_key_version,linky_private._integer(p_payload,'expectedOwnerKeyVersion',1,9007199254740991));
  IF next_hash = w.owner_key_hash THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  at_time := pg_catalog.clock_timestamp();
  UPDATE linky_private.workspaces SET owner_key_hash = next_hash,owner_key_version = w.owner_key_version+1,updated_at = at_time WHERE id = w.id;
  RETURN linky_private._finish(w.id,key,'rotate_owner',w.id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'ownerKeyVersion',w.owner_key_version+1),'owner',w.id,'workspace',w.owner_key_version,w.owner_key_version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.operator_recover_owner(p_operator_id uuid,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; workspace_id_value uuid; key uuid; fp text; old jsonb; at_time timestamptz; next_hash text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','newOwnerHash','expectedOwnerKeyVersion']);
  IF p_operator_id IS NULL THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  workspace_id_value := linky_private._uuid(p_payload,'workspaceId'); key := linky_private._uuid(p_payload,'mutationKey'); next_hash := linky_private._hash(linky_private._text(p_payload,'newOwnerHash',64));
  SELECT * INTO w FROM linky_private.workspaces x WHERE x.id = workspace_id_value FOR UPDATE;
  IF NOT FOUND OR w.state <> 'active' THEN PERFORM linky_private._fail('linky_denied'); END IF;
  fp := linky_private._fingerprint('recover_owner',p_payload); old := linky_private._replay(w.id,key,'recover_owner',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(w.owner_key_version,linky_private._integer(p_payload,'expectedOwnerKeyVersion',1,9007199254740991));
  IF next_hash = w.owner_key_hash THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  at_time := pg_catalog.clock_timestamp();
  UPDATE linky_private.workspaces SET owner_key_hash = next_hash,owner_key_version = w.owner_key_version+1,updated_at = at_time WHERE workspaces.id = w.id;
  RETURN linky_private._finish(w.id,key,'recover_owner',w.id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'ownerKeyVersion',w.owner_key_version+1),'operator',p_operator_id,'workspace',w.owner_key_version,w.owner_key_version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_close(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; key uuid; fp text; old jsonb; at_time timestamptz;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','expectedOwnerKeyVersion']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'),true);
  key := linky_private._uuid(p_payload,'mutationKey'); fp := linky_private._fingerprint('close_workspace',p_payload);
  old := linky_private._replay(w.id,key,'close_workspace',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(w.owner_key_version,linky_private._integer(p_payload,'expectedOwnerKeyVersion',1,9007199254740991));
  at_time := pg_catalog.clock_timestamp(); UPDATE linky_private.workspaces SET state = 'closed',closed_at = at_time,updated_at = at_time WHERE id = w.id;
  RETURN linky_private._finish(w.id,key,'close_workspace',w.id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'state','closed','ownerKeyVersion',w.owner_key_version),'owner',w.id,'workspace',w.owner_key_version,w.owner_key_version,at_time);
END $$;
CREATE FUNCTION linky_private.owner_create_link(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; key uuid; id uuid; revision uuid; fp text; old jsonb; at_time timestamptz; slug text; label text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','revisionId','slug','label','destination','campaign','safety']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'));
  key := linky_private._uuid(p_payload,'mutationKey'); id := linky_private._uuid(p_payload,'linkId'); revision := linky_private._uuid(p_payload,'revisionId');
  slug := linky_private._text(p_payload,'slug',96); label := linky_private._text(p_payload,'label',200); PERFORM linky_private._revision(p_payload);
  IF slug !~ '^[A-Za-z0-9_-]{8,96}$' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  -- Owner writes share a workspace lifetime lock and serialize their mutation key.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(w.id::text || key::text,0));
  fp := linky_private._fingerprint('create_link',p_payload); old := linky_private._replay(w.id,key,'create_link',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  at_time := pg_catalog.clock_timestamp();
  INSERT INTO linky_private.links(id,workspace_id,slug,label,current_revision_id,created_at,updated_at) VALUES(id,w.id,slug,label,revision,at_time,at_time);
  INSERT INTO linky_private.destination_revisions VALUES(revision,w.id,id,1,p_payload->>'destination',linky_private._sha(p_payload->>'destination'),p_payload->'campaign',p_payload->'safety',at_time);
  RETURN linky_private._finish(w.id,key,'create_link',id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',id,'revisionId',revision,'version',1),'owner',w.id,'link',NULL,1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_revise_link(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; key uuid; revision uuid; fp text; old jsonb; at_time timestamptz; number bigint; next_label text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','revisionId','expectedVersion','label','destination','campaign','safety']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l := linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key := linky_private._uuid(p_payload,'mutationKey'); revision := linky_private._uuid(p_payload,'revisionId'); next_label := linky_private._text(p_payload,'label',200); PERFORM linky_private._revision(p_payload);
  fp := linky_private._fingerprint('revise_link',p_payload); old := linky_private._replay(w.id,key,'revise_link',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  SELECT pg_catalog.max(r.revision_number)+1 INTO number FROM linky_private.destination_revisions r WHERE r.workspace_id = w.id AND r.link_id = l.id;
  at_time := pg_catalog.clock_timestamp();
  INSERT INTO linky_private.destination_revisions VALUES(revision,w.id,l.id,number,p_payload->>'destination',linky_private._sha(p_payload->>'destination'),p_payload->'campaign',p_payload->'safety',at_time);
  UPDATE linky_private.links SET label = next_label,current_revision_id = revision,version = l.version+1,updated_at = at_time WHERE id = l.id;
  RETURN linky_private._finish(w.id,key,'revise_link',l.id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'revisionId',revision,'version',l.version+1),'owner',w.id,'link',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_set_link_state(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; key uuid; fp text; old jsonb; at_time timestamptz; next_state text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','expectedVersion','state']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l := linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key := linky_private._uuid(p_payload,'mutationKey'); next_state := linky_private._text(p_payload,'state',10);
  IF next_state NOT IN ('active','paused','blocked') THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  fp := linky_private._fingerprint('set_link_state',p_payload); old := linky_private._replay(w.id,key,'set_link_state',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  at_time := pg_catalog.clock_timestamp(); UPDATE linky_private.links SET state = next_state,version = l.version+1,updated_at = at_time WHERE id = l.id;
  RETURN linky_private._finish(w.id,key,'set_link_state',l.id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'state',next_state,'version',l.version+1),'owner',w.id,'link',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_issue_grant(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; key uuid; id uuid; revision uuid; fp text; old jsonb; at_time timestamptz; expiry timestamptz; uses integer; label text; recipient text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','revisionId','expectedVersion','grantId','recipientHash','label','maxUses','expiresAt']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l := linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key := linky_private._uuid(p_payload,'mutationKey'); id := linky_private._uuid(p_payload,'grantId'); revision := linky_private._uuid(p_payload,'revisionId');
  recipient := linky_private._hash(linky_private._text(p_payload,'recipientHash',64)); label := linky_private._text(p_payload,'label',200); uses := linky_private._integer(p_payload,'maxUses',1,1000000); expiry := linky_private._instant(p_payload,'expiresAt');
  fp := linky_private._fingerprint('issue_grant',p_payload); old := linky_private._replay(w.id,key,'issue_grant',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  IF NOT EXISTS(SELECT 1 FROM linky_private.destination_revisions r WHERE r.workspace_id = w.id AND r.link_id = l.id AND r.id = revision) THEN PERFORM linky_private._fail('linky_scope'); END IF;
  at_time := pg_catalog.clock_timestamp(); IF expiry <= at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  INSERT INTO linky_private.grants(id,workspace_id,link_id,revision_id,recipient_key_hash,label,max_uses,expires_at,created_at) VALUES(id,w.id,l.id,revision,recipient,label,uses,expiry,at_time);
  UPDATE linky_private.links SET version = l.version+1,updated_at = at_time WHERE links.id = l.id;
  RETURN linky_private._finish(w.id,key,'issue_grant',id,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'grantId',id,'revisionId',revision,'version',l.version+1),'owner',w.id,'grant',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_revoke_grant(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; g linky_private.grants; key uuid; grant_id_value uuid; fp text; old jsonb; at_time timestamptz;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','grantId','expectedVersion']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l := linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key := linky_private._uuid(p_payload,'mutationKey'); grant_id_value := linky_private._uuid(p_payload,'grantId');
  fp := linky_private._fingerprint('revoke_grant',p_payload); old := linky_private._replay(w.id,key,'revoke_grant',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  SELECT * INTO g FROM linky_private.grants x WHERE x.workspace_id = w.id AND x.link_id = l.id AND x.id = grant_id_value FOR UPDATE;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  at_time := pg_catalog.clock_timestamp();
  UPDATE linky_private.grants SET revoked_at = COALESCE(g.revoked_at,at_time) WHERE grants.id = g.id;
  UPDATE linky_private.links SET version = l.version+1,updated_at = at_time WHERE links.id = l.id;
  RETURN linky_private._finish(w.id,key,'revoke_grant',grant_id_value,fp,w.owner_key_version,pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'grantId',g.id,'version',l.version+1),'owner',w.id,'grant',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;

CREATE FUNCTION linky_private.owner_list_links(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; amount integer := 50; cursor_id uuid; wanted_state text; search text := ''; rows jsonb; next_id uuid;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId'],ARRAY['limit','after','state','search']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'));
  IF p_payload ? 'limit' THEN amount := linky_private._integer(p_payload,'limit',1,100); END IF;
  IF p_payload ? 'after' AND p_payload->'after' <> 'null'::jsonb THEN cursor_id := linky_private._uuid(p_payload,'after'); END IF;
  IF p_payload ? 'state' AND p_payload->'state' <> 'null'::jsonb THEN wanted_state := linky_private._text(p_payload,'state',10); IF wanted_state NOT IN ('active','paused','blocked') THEN PERFORM linky_private._fail('linky_invalid'); END IF; END IF;
  IF p_payload ? 'search' THEN search := linky_private._text(p_payload,'search',200,true); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY id),'[]'::jsonb), (pg_catalog.array_agg(id ORDER BY id))[amount]
  INTO rows,next_id FROM (
    SELECT l.id,pg_catalog.jsonb_build_object('id',l.id,'slug',l.slug,'label',l.label,'state',l.state,'version',l.version,'currentRevisionId',l.current_revision_id,
      'destination',r.destination_url,'campaign',r.campaign_snapshot,'safety',r.safety_snapshot,'createdAt',l.created_at,'updatedAt',l.updated_at) item
    FROM linky_private.links l JOIN linky_private.destination_revisions r ON (r.workspace_id,r.link_id,r.id)=(l.workspace_id,l.id,l.current_revision_id)
    WHERE l.workspace_id=w.id AND (cursor_id IS NULL OR l.id>cursor_id) AND (wanted_state IS NULL OR l.state=wanted_state)
      AND (search='' OR pg_catalog.strpos(pg_catalog.lower(l.label),pg_catalog.lower(search))>0 OR pg_catalog.strpos(pg_catalog.lower(l.slug),pg_catalog.lower(search))>0)
    ORDER BY l.id LIMIT amount
  ) selected;
  RETURN pg_catalog.jsonb_build_object('links',rows,'nextCursor',CASE WHEN pg_catalog.jsonb_array_length(rows)=amount THEN pg_catalog.to_jsonb(next_id) ELSE 'null'::jsonb END);
END $$;
CREATE FUNCTION linky_private.owner_list_grants(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; amount integer := 50; cursor_id uuid; rows jsonb; next_id uuid;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','linkId'],ARRAY['limit','after']);
  w := linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l := linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'),false);
  IF p_payload ? 'limit' THEN amount:=linky_private._integer(p_payload,'limit',1,100); END IF;
  IF p_payload ? 'after' AND p_payload->'after'<>'null'::jsonb THEN cursor_id:=linky_private._uuid(p_payload,'after'); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY id),'[]'::jsonb),(pg_catalog.array_agg(id ORDER BY id))[amount] INTO rows,next_id FROM (
    SELECT g.id,pg_catalog.jsonb_build_object('id',g.id,'linkId',g.link_id,'revisionId',g.revision_id,'label',g.label,'maxUses',g.max_uses,'usedCount',g.used_count,'expiresAt',g.expires_at,'revokedAt',g.revoked_at,'createdAt',g.created_at) item
    FROM linky_private.grants g WHERE g.workspace_id=w.id AND g.link_id=l.id AND (cursor_id IS NULL OR g.id>cursor_id) ORDER BY g.id LIMIT amount
  ) selected;
  RETURN pg_catalog.jsonb_build_object('grants',rows,'nextCursor',CASE WHEN pg_catalog.jsonb_array_length(rows)=amount THEN pg_catalog.to_jsonb(next_id) ELSE 'null'::jsonb END);
END $$;
CREATE FUNCTION linky_private._recipient(hash text,grant_id uuid,write_lock boolean) RETURNS linky_private.grants
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE hint linky_private.grants; g linky_private.grants; w linky_private.workspaces; l linky_private.links; at_time timestamptz;
BEGIN
  PERFORM linky_private._hash(hash);
  SELECT * INTO hint FROM linky_private.grants x WHERE x.id = grant_id;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_denied'); END IF;
  SELECT * INTO w FROM linky_private.workspaces x WHERE x.id=hint.workspace_id FOR SHARE;
  l := linky_private._link(w.id,hint.link_id,write_lock);
  IF write_lock THEN SELECT * INTO g FROM linky_private.grants x WHERE x.id=grant_id FOR UPDATE;
  ELSE SELECT * INTO g FROM linky_private.grants x WHERE x.id=grant_id FOR SHARE; END IF;
  IF g.recipient_key_hash <> hash THEN PERFORM linky_private._fail('linky_denied'); END IF;
  IF w.state <> 'active' THEN PERFORM linky_private._fail('linky_closed'); END IF;
  IF l.state <> 'active' THEN PERFORM linky_private._fail('linky_inactive'); END IF;
  at_time := pg_catalog.clock_timestamp();
  IF g.revoked_at IS NOT NULL THEN PERFORM linky_private._fail('linky_revoked'); END IF;
  IF g.expires_at <= at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  RETURN g;
END $$;
CREATE FUNCTION linky_private.recipient_inspect(p_recipient_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g linky_private.grants; r linky_private.destination_revisions;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['grantId']);
  g:=linky_private._recipient(p_recipient_hash,linky_private._uuid(p_payload,'grantId'),false);
  SELECT * INTO r FROM linky_private.destination_revisions x WHERE (x.workspace_id,x.link_id,x.id)=(g.workspace_id,g.link_id,g.revision_id);
  RETURN pg_catalog.jsonb_build_object('grantId',g.id,'linkId',g.link_id,'label',g.label,'hostname',r.safety_snapshot->>'hostname','safety',r.safety_snapshot,'expiresAt',g.expires_at,'remainingUses',g.max_uses-g.used_count);
END $$;
CREATE FUNCTION linky_private.recipient_redeem(p_recipient_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g linky_private.grants; r linky_private.destination_revisions; receipt linky_private.redemption_receipts; key uuid; fp text; at_time timestamptz; replay boolean := false;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['grantId','redemptionKey']);
  g:=linky_private._recipient(p_recipient_hash,linky_private._uuid(p_payload,'grantId'),true); key:=linky_private._uuid(p_payload,'redemptionKey');
  fp:=linky_private._fingerprint('redeem',pg_catalog.jsonb_build_object('workspaceId',g.workspace_id,'grantId',g.id,'linkId',g.link_id,'revisionId',g.revision_id));
  SELECT * INTO r FROM linky_private.destination_revisions x WHERE (x.workspace_id,x.link_id,x.id)=(g.workspace_id,g.link_id,g.revision_id);
  SELECT * INTO receipt FROM linky_private.redemption_receipts x WHERE x.grant_id=g.id AND x.redemption_key=key;
  IF FOUND THEN
    IF receipt.request_fingerprint<>fp THEN PERFORM linky_private._fail('linky_conflict'); END IF;
    replay:=true;
  ELSE
    IF g.used_count>=g.max_uses THEN PERFORM linky_private._fail('linky_exhausted'); END IF;
    at_time:=pg_catalog.clock_timestamp();
    UPDATE linky_private.grants SET used_count=g.used_count+1 WHERE id=g.id;
    INSERT INTO linky_private.redemption_receipts VALUES(pg_catalog.gen_random_uuid(),g.workspace_id,g.link_id,g.revision_id,g.id,key,fp,g.used_count+1,r.destination_sha256,r.campaign_snapshot,at_time) RETURNING * INTO receipt;
    INSERT INTO linky_private.attribution_events VALUES(pg_catalog.gen_random_uuid(),g.workspace_id,g.link_id,g.revision_id,receipt.id,'redemption_committed',r.campaign_snapshot,at_time);
    PERFORM linky_private._audit(g.workspace_id,'recipient',g.id,NULL,'redeem','grant',g.id,NULL,NULL,at_time);
  END IF;
  RETURN pg_catalog.jsonb_build_object('receiptId',receipt.id,'grantId',g.id,'linkId',g.link_id,'revisionId',g.revision_id,'useNumber',receipt.use_number,'redeemedAt',receipt.redeemed_at,'destination',r.destination_url,'replayed',replay);
END $$;
CREATE FUNCTION linky_private.owner_report(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; start_at timestamptz; end_at timestamptz; amount integer:=1000; selected jsonb; campaigns jsonb; count_rows integer; truncated boolean;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId'],ARRAY['from','to','limit']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'));
  end_at:=pg_catalog.clock_timestamp(); start_at:=end_at-interval '30 days';
  IF p_payload?'from' AND p_payload->'from'<>'null'::jsonb THEN start_at:=linky_private._instant(p_payload,'from'); END IF;
  IF p_payload?'to' AND p_payload->'to'<>'null'::jsonb THEN end_at:=linky_private._instant(p_payload,'to'); END IF;
  IF end_at<=start_at OR end_at-start_at>interval '366 days' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  IF p_payload?'limit' THEN amount:=linky_private._integer(p_payload,'limit',1,5000); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(campaign_snapshot ORDER BY redeemed_at DESC,id DESC),'[]'::jsonb) INTO selected FROM (
    SELECT x.id,x.redeemed_at,x.campaign_snapshot FROM linky_private.redemption_receipts x WHERE x.workspace_id=w.id AND x.redeemed_at>=start_at AND x.redeemed_at<end_at ORDER BY x.redeemed_at DESC,x.id DESC LIMIT amount+1
  ) bounded;
  truncated:=pg_catalog.jsonb_array_length(selected)>amount; selected:=COALESCE((SELECT pg_catalog.jsonb_agg(value ORDER BY ordinality) FROM pg_catalog.jsonb_array_elements(selected) WITH ORDINALITY WHERE ordinality<=amount),'[]'::jsonb);
  count_rows:=pg_catalog.jsonb_array_length(selected);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('campaign',campaign,'redemptions',total) ORDER BY campaign::text),'[]'::jsonb) INTO campaigns FROM (
    SELECT value campaign,pg_catalog.count(*) total FROM pg_catalog.jsonb_array_elements(selected) GROUP BY value
  ) grouped;
  RETURN pg_catalog.jsonb_build_object('redemptions',count_rows,'campaigns',campaigns,'coverage',pg_catalog.jsonb_build_object('kind','committed_redemptions','from',start_at,'to',end_at,'limit',amount,'recordCount',count_rows,'truncated',truncated),'conversionsAvailable',false);
END $$;

ALTER TABLE linky_private.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.links ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.destination_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.redemption_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.attribution_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.mutation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA linky_private FROM PUBLIC,linky_runtime,linky_operator;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA linky_private FROM PUBLIC,linky_runtime,linky_operator;
ALTER DEFAULT PRIVILEGES IN SCHEMA linky_private REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA linky_private REVOKE ALL ON TABLES FROM PUBLIC;
GRANT EXECUTE ON FUNCTION linky_private.operator_provision(uuid,jsonb),linky_private.operator_recover_owner(uuid,jsonb) TO linky_operator;
GRANT EXECUTE ON FUNCTION
  linky_private.owner_connect(text,jsonb),linky_private.owner_rotate(text,jsonb),linky_private.owner_close(text,jsonb),
  linky_private.owner_create_link(text,jsonb),linky_private.owner_revise_link(text,jsonb),linky_private.owner_set_link_state(text,jsonb),
  linky_private.owner_issue_grant(text,jsonb),linky_private.owner_revoke_grant(text,jsonb),linky_private.owner_list_links(text,jsonb),linky_private.owner_list_grants(text,jsonb),
  linky_private.recipient_inspect(text,jsonb),linky_private.recipient_redeem(text,jsonb),linky_private.owner_report(text,jsonb) TO linky_runtime;
COMMIT;
