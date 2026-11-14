-- V3 proposal. The pinned CI CLI generates the additive migration scaffold;
-- this content populates that scaffold. Never edit the accepted V1/V2 files.
BEGIN;
SET LOCAL ROLE linky_function_owner;
SET LOCAL search_path = '';

CREATE OR REPLACE FUNCTION linky_private._text(value jsonb,key text,maximum integer,empty_ok boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result text;
BEGIN
  IF pg_catalog.jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  result:=value->>key;
  IF pg_catalog.length(result)>maximum OR result ~ '[[:cntrl:]]' OR result ~ 'ly[oripa]_[0-9a-f]{64}'
    OR (NOT empty_ok AND pg_catalog.length(pg_catalog.btrim(result))=0) THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result;
END $$;
ALTER TABLE linky_private.mutation_receipts DROP CONSTRAINT mutation_receipts_operation_check;
ALTER TABLE linky_private.mutation_receipts ADD CONSTRAINT mutation_receipts_operation_check CHECK
  (operation IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant','issue_conversion_credential','revoke_conversion_credential','issue_origin_credential','revoke_origin_credential'));
ALTER TABLE linky_private.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE linky_private.audit_events ADD CONSTRAINT audit_events_action_check CHECK
  (action IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant','redeem','issue_conversion_credential','revoke_conversion_credential','conversion_ingest','issue_origin_credential','revoke_origin_credential','prepare_resource_access'));
ALTER TABLE linky_private.audit_events DROP CONSTRAINT audit_events_resource_kind_check;
ALTER TABLE linky_private.audit_events ADD CONSTRAINT audit_events_resource_kind_check CHECK
  (resource_kind IN ('workspace','link','grant','conversion_credential','conversion_event','origin_credential','resource_access'));

CREATE TABLE linky_private.origin_credentials (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  origin_key_hash text NOT NULL UNIQUE CHECK (origin_key_hash ~ '^[0-9a-f]{64}$'),
  label varchar(200) NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(label))>0 AND label !~ '[[:cntrl:]]' AND label !~ 'ly[oripa]_[0-9a-f]{64}'),
  purpose text NOT NULL CHECK (purpose='resource_authorize'),
  resource_url varchar(2048) NOT NULL CHECK (resource_url ~ '^https://' AND resource_url !~ '#' AND resource_url !~ '[[:cntrl:]]' AND resource_url !~ 'ly[oripa]_[0-9a-f]{64}'),
  expires_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(expires_at)), revoked_at timestamptz,
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at)),
  CHECK (expires_at>created_at), CHECK (revoked_at IS NULL OR (pg_catalog.isfinite(revoked_at) AND revoked_at>=created_at)),
  UNIQUE (workspace_id,link_id,revision_id,id),
  FOREIGN KEY (workspace_id,link_id,revision_id) REFERENCES linky_private.destination_revisions(workspace_id,link_id,id)
);
CREATE INDEX origin_credentials_owner_list ON linky_private.origin_credentials(workspace_id,link_id,id);
CREATE TABLE linky_private.resource_access (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  receipt_id uuid NOT NULL UNIQUE,
  access_key_hash text NOT NULL UNIQUE CHECK (access_key_hash ~ '^[0-9a-f]{64}$'),
  version bigint NOT NULL CHECK (version BETWEEN 1 AND 9007199254740991),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at)),
  updated_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(updated_at) AND updated_at>=created_at),
  FOREIGN KEY (workspace_id,link_id,revision_id,receipt_id) REFERENCES linky_private.redemption_receipts(workspace_id,link_id,revision_id,id)
);
CREATE FUNCTION linky_private._origin_credential_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP='DELETE' OR (pg_catalog.to_jsonb(NEW)-'revoked_at')<>(pg_catalog.to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN PERFORM linky_private._fail('linky_immutable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER constrained_origin_credentials BEFORE UPDATE OR DELETE ON linky_private.origin_credentials FOR EACH ROW EXECUTE FUNCTION linky_private._origin_credential_change();
CREATE FUNCTION linky_private._resource_access_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP='DELETE' OR (pg_catalog.to_jsonb(NEW)-ARRAY['id','access_key_hash','request_fingerprint','version','updated_at'])<>(pg_catalog.to_jsonb(OLD)-ARRAY['id','access_key_hash','request_fingerprint','version','updated_at'])
    OR NEW.version<>OLD.version+1 OR NEW.updated_at<OLD.updated_at THEN PERFORM linky_private._fail('linky_immutable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER constrained_resource_access BEFORE UPDATE OR DELETE ON linky_private.resource_access FOR EACH ROW EXECUTE FUNCTION linky_private._resource_access_change();

CREATE FUNCTION linky_private.owner_issue_origin_credential(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; key uuid; credential uuid; revision uuid; fp text; old jsonb; at_time timestamptz; expiry timestamptz; digest text; label_value text; target text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','revisionId','expectedVersion','credentialId','originHash','label','expiresAt']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key:=linky_private._uuid(p_payload,'mutationKey'); credential:=linky_private._uuid(p_payload,'credentialId'); revision:=linky_private._uuid(p_payload,'revisionId');
  digest:=linky_private._hash(linky_private._text(p_payload,'originHash',64)); label_value:=linky_private._text(p_payload,'label',200); expiry:=linky_private._instant(p_payload,'expiresAt');
  fp:=linky_private._fingerprint('issue_origin_credential',p_payload); old:=linky_private._replay(w.id,key,'issue_origin_credential',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  SELECT r.destination_url INTO target FROM linky_private.destination_revisions r WHERE (r.workspace_id,r.link_id,r.id)=(w.id,l.id,revision);
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  IF target !~ '^https://' OR target ~ '#' OR target ~ 'ly[oripa]_[0-9a-f]{64}' THEN PERFORM linky_private._fail('linky_resource_unavailable'); END IF;
  at_time:=pg_catalog.clock_timestamp(); IF expiry<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  INSERT INTO linky_private.origin_credentials VALUES(credential,w.id,l.id,revision,digest,label_value,'resource_authorize',target,expiry,NULL,at_time);
  UPDATE linky_private.links SET version=l.version+1,updated_at=at_time WHERE id=l.id;
  RETURN linky_private._finish(w.id,key,'issue_origin_credential',credential,fp,w.owner_key_version,
    pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'credentialId',credential,'revisionId',revision,'resourceUrl',target,'version',l.version+1),'owner',w.id,'origin_credential',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_list_origin_credentials(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; amount integer:=50; cursor_id uuid; rows jsonb; next_id uuid;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','linkId'],ARRAY['limit','after']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'),false);
  IF p_payload?'limit' THEN amount:=linky_private._integer(p_payload,'limit',1,50); END IF;
  IF p_payload?'after' AND p_payload->'after'<>'null'::jsonb THEN cursor_id:=linky_private._uuid(p_payload,'after'); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY id),'[]'::jsonb),(pg_catalog.array_agg(id ORDER BY id))[amount] INTO rows,next_id FROM (
    SELECT c.id,pg_catalog.jsonb_build_object('id',c.id,'linkId',c.link_id,'revisionId',c.revision_id,'resourceUrl',c.resource_url,'label',c.label,'purpose',c.purpose,'expiresAt',c.expires_at,'revokedAt',c.revoked_at,'createdAt',c.created_at) item
    FROM linky_private.origin_credentials c WHERE c.workspace_id=w.id AND c.link_id=l.id AND (cursor_id IS NULL OR c.id>cursor_id) ORDER BY c.id LIMIT amount
  ) selected;
  RETURN pg_catalog.jsonb_build_object('credentials',rows,'nextCursor',CASE WHEN pg_catalog.jsonb_array_length(rows)=amount THEN pg_catalog.to_jsonb(next_id) ELSE 'null'::jsonb END);
END $$;
CREATE FUNCTION linky_private.owner_revoke_origin_credential(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; c linky_private.origin_credentials; credential uuid; key uuid; fp text; old jsonb; at_time timestamptz;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','credentialId','expectedVersion']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key:=linky_private._uuid(p_payload,'mutationKey'); credential:=linky_private._uuid(p_payload,'credentialId'); fp:=linky_private._fingerprint('revoke_origin_credential',p_payload);
  old:=linky_private._replay(w.id,key,'revoke_origin_credential',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  SELECT * INTO c FROM linky_private.origin_credentials x WHERE x.workspace_id=w.id AND x.link_id=l.id AND x.id=credential FOR UPDATE;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  at_time:=pg_catalog.clock_timestamp(); UPDATE linky_private.origin_credentials SET revoked_at=COALESCE(c.revoked_at,at_time) WHERE id=c.id;
  UPDATE linky_private.links SET version=l.version+1,updated_at=at_time WHERE id=l.id;
  RETURN linky_private._finish(w.id,key,'revoke_origin_credential',c.id,fp,w.owner_key_version,
    pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'credentialId',c.id,'version',l.version+1),'owner',w.id,'origin_credential',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;

-- Reuse the accepted recipient authority/lock order; no use is consumed here.
CREATE FUNCTION linky_private._resource_receipt(g linky_private.grants,receipt uuid) RETURNS linky_private.redemption_receipts
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result linky_private.redemption_receipts;
BEGIN
  SELECT * INTO result FROM linky_private.redemption_receipts r WHERE r.id=receipt AND r.grant_id=g.id
    AND (r.workspace_id,r.link_id,r.revision_id)=(g.workspace_id,g.link_id,g.revision_id);
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_denied'); END IF;
  RETURN result;
END $$;
CREATE FUNCTION linky_private._resource_target(g linky_private.grants) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE target text;
BEGIN
  SELECT r.destination_url INTO target FROM linky_private.destination_revisions r WHERE (r.workspace_id,r.link_id,r.id)=(g.workspace_id,g.link_id,g.revision_id);
  IF target !~ '^https://' OR target ~ '#' OR NOT EXISTS(SELECT 1 FROM linky_private.origin_credentials c
    WHERE (c.workspace_id,c.link_id,c.revision_id)=(g.workspace_id,g.link_id,g.revision_id) AND c.revoked_at IS NULL AND c.expires_at>pg_catalog.clock_timestamp())
    THEN PERFORM linky_private._fail('linky_resource_unavailable'); END IF;
  RETURN target;
END $$;
CREATE FUNCTION linky_private.recipient_resource_inspect(p_recipient_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g linky_private.grants; receipt linky_private.redemption_receipts; access_version bigint; target text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['grantId','receiptId']);
  g:=linky_private._recipient(p_recipient_hash,linky_private._uuid(p_payload,'grantId'),false);
  receipt:=linky_private._resource_receipt(g,linky_private._uuid(p_payload,'receiptId')); target:=linky_private._resource_target(g);
  SELECT a.version INTO access_version FROM linky_private.resource_access a WHERE a.receipt_id=receipt.id;
  RETURN pg_catalog.jsonb_build_object('grantId',g.id,'receiptId',receipt.id,'linkId',g.link_id,'revisionId',g.revision_id,'resourceUrl',target,'accessVersion',COALESCE(access_version,0),'expiresAt',g.expires_at);
END $$;
CREATE FUNCTION linky_private.recipient_prepare_resource_access(p_recipient_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE g linky_private.grants; receipt linky_private.redemption_receipts; a linky_private.resource_access; access_id uuid; digest text; expected bigint; fp text; target text; at_time timestamptz; replay boolean:=false; prior bigint:=0;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['grantId','receiptId','accessId','accessHash','expectedAccessVersion']);
  g:=linky_private._recipient(p_recipient_hash,linky_private._uuid(p_payload,'grantId'),true);
  receipt:=linky_private._resource_receipt(g,linky_private._uuid(p_payload,'receiptId'));
  access_id:=linky_private._uuid(p_payload,'accessId'); digest:=linky_private._hash(linky_private._text(p_payload,'accessHash',64));
  expected:=linky_private._integer(p_payload,'expectedAccessVersion',0,9007199254740990); fp:=linky_private._fingerprint('prepare_resource_access',p_payload);
  SELECT * INTO a FROM linky_private.resource_access x WHERE x.receipt_id=receipt.id FOR UPDATE;
  -- All potentially waiting locks precede the authoritative time checks.
  at_time:=pg_catalog.clock_timestamp(); IF g.expires_at<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  target:=linky_private._resource_target(g);
  IF a.id IS NOT NULL THEN
    prior:=a.version;
    IF a.id=access_id THEN
      IF a.access_key_hash<>digest OR a.request_fingerprint<>fp THEN PERFORM linky_private._fail('linky_conflict'); END IF;
      replay:=true;
    ELSE
      PERFORM linky_private._cas(prior,expected);
      UPDATE linky_private.resource_access SET id=access_id,access_key_hash=digest,request_fingerprint=fp,version=prior+1,updated_at=at_time WHERE receipt_id=receipt.id RETURNING * INTO a;
    END IF;
  ELSE
    PERFORM linky_private._cas(0,expected);
    INSERT INTO linky_private.resource_access VALUES(access_id,g.workspace_id,g.link_id,g.revision_id,receipt.id,digest,1,fp,at_time,at_time) RETURNING * INTO a;
  END IF;
  IF NOT replay THEN PERFORM linky_private._audit(g.workspace_id,'recipient',g.id,NULL,'prepare_resource_access','resource_access',a.id,prior,a.version,at_time); END IF;
  RETURN pg_catalog.jsonb_build_object('grantId',g.id,'receiptId',receipt.id,'linkId',g.link_id,'revisionId',g.revision_id,'resourceUrl',target,'accessId',a.id,'version',a.version,'expiresAt',g.expires_at,'replayed',replay);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.origin_authorize(p_origin_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE hint linky_private.origin_credentials; c linky_private.origin_credentials; a linky_private.resource_access; receipt linky_private.redemption_receipts; g linky_private.grants; w linky_private.workspaces; l linky_private.links; credential uuid; access_id uuid; digest text; at_time timestamptz;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['credentialId','accessId','accessHash']); PERFORM linky_private._hash(p_origin_hash);
  credential:=linky_private._uuid(p_payload,'credentialId'); access_id:=linky_private._uuid(p_payload,'accessId'); digest:=linky_private._hash(linky_private._text(p_payload,'accessHash',64));
  SELECT * INTO hint FROM linky_private.origin_credentials x WHERE x.id=credential;
  SELECT * INTO a FROM linky_private.resource_access x WHERE x.id=access_id;
  IF hint.id IS NULL OR a.id IS NULL OR (hint.workspace_id,hint.link_id,hint.revision_id)<>(a.workspace_id,a.link_id,a.revision_id) THEN PERFORM linky_private._fail('linky_denied'); END IF;
  SELECT * INTO receipt FROM linky_private.redemption_receipts r WHERE r.id=a.receipt_id;
  SELECT * INTO w FROM linky_private.workspaces x WHERE x.id=hint.workspace_id FOR SHARE;
  l:=linky_private._link(w.id,hint.link_id,false);
  SELECT * INTO g FROM linky_private.grants x WHERE x.id=receipt.grant_id FOR SHARE;
  SELECT * INTO c FROM linky_private.origin_credentials x WHERE x.id=credential FOR SHARE;
  SELECT * INTO a FROM linky_private.resource_access x WHERE x.id=access_id FOR SHARE;
  IF a.id IS NULL OR a.access_key_hash<>digest OR c.origin_key_hash<>p_origin_hash OR c.purpose<>'resource_authorize'
    OR a.receipt_id<>receipt.id OR (a.workspace_id,a.link_id,a.revision_id)<>(c.workspace_id,c.link_id,c.revision_id)
    OR (g.workspace_id,g.link_id,g.revision_id)<>(a.workspace_id,a.link_id,a.revision_id) THEN PERFORM linky_private._fail('linky_denied'); END IF;
  IF w.state<>'active' THEN PERFORM linky_private._fail('linky_closed'); END IF;
  IF l.state<>'active' THEN PERFORM linky_private._fail('linky_inactive'); END IF;
  at_time:=pg_catalog.clock_timestamp();
  IF g.revoked_at IS NOT NULL THEN PERFORM linky_private._fail('linky_revoked'); END IF;
  IF g.expires_at<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  IF c.revoked_at IS NOT NULL THEN PERFORM linky_private._fail('linky_origin_revoked'); END IF;
  IF c.expires_at<=at_time THEN PERFORM linky_private._fail('linky_origin_expired'); END IF;
  RETURN pg_catalog.jsonb_build_object('authorized',true,'credentialId',c.id,'accessId',a.id,'receiptId',receipt.id,'linkId',g.link_id,'revisionId',g.revision_id,'resourceUrl',c.resource_url,'expiresAt',LEAST(g.expires_at,c.expires_at));
END $$;

ALTER TABLE linky_private.origin_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.resource_access ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON linky_private.origin_credentials,linky_private.resource_access FROM PUBLIC,linky_runtime,linky_operator;
REVOKE ALL ON FUNCTION linky_private._origin_credential_change(),linky_private._resource_access_change(),linky_private._resource_receipt(linky_private.grants,uuid),linky_private._resource_target(linky_private.grants),
  linky_private.owner_issue_origin_credential(text,jsonb),linky_private.owner_list_origin_credentials(text,jsonb),linky_private.owner_revoke_origin_credential(text,jsonb),
  linky_private.recipient_resource_inspect(text,jsonb),linky_private.recipient_prepare_resource_access(text,jsonb),linky_private.origin_authorize(text,jsonb) FROM PUBLIC,linky_runtime,linky_operator;
GRANT EXECUTE ON FUNCTION linky_private.owner_issue_origin_credential(text,jsonb),linky_private.owner_list_origin_credentials(text,jsonb),linky_private.owner_revoke_origin_credential(text,jsonb),
  linky_private.recipient_resource_inspect(text,jsonb),linky_private.recipient_prepare_resource_access(text,jsonb),linky_private.origin_authorize(text,jsonb) TO linky_runtime;
COMMIT;
