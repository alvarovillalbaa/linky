-- Populates the exact Supabase 2.122.0 V2 scaffold generated in pinned CI.
-- V1 is immutable. Apply after its accepted schema, never from app startup.
BEGIN;
SET LOCAL ROLE linky_function_owner;
SET LOCAL search_path = '';

CREATE OR REPLACE FUNCTION linky_private._text(value jsonb,key text,maximum integer,empty_ok boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE result text;
BEGIN
  IF pg_catalog.jsonb_typeof(value->key) IS DISTINCT FROM 'string' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  result:=value->>key;
  IF pg_catalog.length(result)>maximum OR result ~ '[[:cntrl:]]' OR result ~ 'ly[ori]_[0-9a-f]{64}'
    OR (NOT empty_ok AND pg_catalog.length(pg_catalog.btrim(result))=0) THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  RETURN result;
END $$;
ALTER TABLE linky_private.mutation_receipts DROP CONSTRAINT mutation_receipts_operation_check;
ALTER TABLE linky_private.mutation_receipts ADD CONSTRAINT mutation_receipts_operation_check CHECK
  (operation IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant','issue_conversion_credential','revoke_conversion_credential'));
ALTER TABLE linky_private.audit_events DROP CONSTRAINT audit_events_actor_kind_check;
ALTER TABLE linky_private.audit_events ADD CONSTRAINT audit_events_actor_kind_check CHECK (actor_kind IN ('operator','owner','recipient','conversion_ingest'));
ALTER TABLE linky_private.audit_events DROP CONSTRAINT audit_events_action_check;
ALTER TABLE linky_private.audit_events ADD CONSTRAINT audit_events_action_check CHECK
  (action IN ('provision','recover_owner','rotate_owner','close_workspace','create_link','revise_link','set_link_state','issue_grant','revoke_grant','redeem','issue_conversion_credential','revoke_conversion_credential','conversion_ingest'));
ALTER TABLE linky_private.audit_events DROP CONSTRAINT audit_events_resource_kind_check;
ALTER TABLE linky_private.audit_events ADD CONSTRAINT audit_events_resource_kind_check CHECK (resource_kind IN ('workspace','link','grant','conversion_credential','conversion_event'));

CREATE TABLE linky_private.conversion_credentials (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  ingest_key_hash text NOT NULL UNIQUE CHECK (ingest_key_hash ~ '^[0-9a-f]{64}$'),
  label varchar(200) NOT NULL CHECK (pg_catalog.length(pg_catalog.btrim(label))>0 AND label !~ '[[:cntrl:]]' AND label !~ 'ly[ori]_[0-9a-f]{64}'),
  purpose text NOT NULL CHECK (purpose='conversion_ingest'),
  expires_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(expires_at)), revoked_at timestamptz,
  created_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(created_at)),
  CHECK (expires_at>created_at), CHECK (revoked_at IS NULL OR (pg_catalog.isfinite(revoked_at) AND revoked_at>=created_at)),
  UNIQUE (workspace_id,link_id,revision_id,id),
  FOREIGN KEY (workspace_id,link_id,revision_id) REFERENCES linky_private.destination_revisions(workspace_id,link_id,id)
);
CREATE INDEX conversion_credentials_owner_list ON linky_private.conversion_credentials(workspace_id,link_id,id);
CREATE TABLE linky_private.conversion_events (
  id uuid PRIMARY KEY, workspace_id uuid NOT NULL, link_id uuid NOT NULL, revision_id uuid NOT NULL,
  receipt_id uuid NOT NULL, credential_id uuid NOT NULL, event_key uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('lead_declared','sale_declared')), amount_minor bigint, currency char(3),
  declared_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(declared_at)),
  accepted_at timestamptz NOT NULL CHECK (pg_catalog.isfinite(accepted_at)),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[0-9a-f]{64}$'),
  campaign_snapshot jsonb NOT NULL CHECK (pg_catalog.jsonb_typeof(campaign_snapshot)='object' AND pg_catalog.pg_column_size(campaign_snapshot)<=4096
    AND campaign_snapshot ?& ARRAY['source','medium','campaign'] AND campaign_snapshot-ARRAY['source','medium','campaign']='{}'::jsonb
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'source')='string' AND pg_catalog.length(campaign_snapshot->>'source')<=100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'medium')='string' AND pg_catalog.length(campaign_snapshot->>'medium')<=100
    AND pg_catalog.jsonb_typeof(campaign_snapshot->'campaign')='string' AND pg_catalog.length(campaign_snapshot->>'campaign')<=100),
  CHECK ((kind='lead_declared' AND amount_minor IS NULL AND currency IS NULL)
    OR (kind='sale_declared' AND ((amount_minor IS NULL AND currency IS NULL)
      OR (amount_minor IS NOT NULL AND currency IS NOT NULL AND amount_minor BETWEEN 0 AND 9007199254740991 AND currency ~ '^[A-Z]{3}$')))),
  UNIQUE (workspace_id,event_key),
  FOREIGN KEY (workspace_id,link_id,revision_id,receipt_id) REFERENCES linky_private.redemption_receipts(workspace_id,link_id,revision_id,id),
  FOREIGN KEY (workspace_id,link_id,revision_id,credential_id) REFERENCES linky_private.conversion_credentials(workspace_id,link_id,revision_id,id)
);
CREATE INDEX conversion_events_report ON linky_private.conversion_events(workspace_id,accepted_at,kind,currency,link_id,id);
CREATE TRIGGER immutable_conversion_events BEFORE UPDATE OR DELETE ON linky_private.conversion_events FOR EACH ROW EXECUTE FUNCTION linky_private._immutable();
CREATE FUNCTION linky_private._conversion_credential_change() RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF TG_OP='DELETE' OR (pg_catalog.to_jsonb(NEW)-'revoked_at')<>(pg_catalog.to_jsonb(OLD)-'revoked_at')
    OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN PERFORM linky_private._fail('linky_immutable'); END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER constrained_conversion_credentials BEFORE UPDATE OR DELETE ON linky_private.conversion_credentials FOR EACH ROW EXECUTE FUNCTION linky_private._conversion_credential_change();

CREATE FUNCTION linky_private.owner_issue_conversion_credential(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; key uuid; credential uuid; revision uuid; fp text; old jsonb; at_time timestamptz; expiry timestamptz; digest text; label_value text;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','revisionId','expectedVersion','credentialId','ingestHash','label','expiresAt']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key:=linky_private._uuid(p_payload,'mutationKey'); credential:=linky_private._uuid(p_payload,'credentialId'); revision:=linky_private._uuid(p_payload,'revisionId');
  digest:=linky_private._hash(linky_private._text(p_payload,'ingestHash',64)); label_value:=linky_private._text(p_payload,'label',200); expiry:=linky_private._instant(p_payload,'expiresAt');
  fp:=linky_private._fingerprint('issue_conversion_credential',p_payload); old:=linky_private._replay(w.id,key,'issue_conversion_credential',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  IF NOT EXISTS(SELECT 1 FROM linky_private.destination_revisions r WHERE (r.workspace_id,r.link_id,r.id)=(w.id,l.id,revision)) THEN PERFORM linky_private._fail('linky_scope'); END IF;
  at_time:=pg_catalog.clock_timestamp(); IF expiry<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  INSERT INTO linky_private.conversion_credentials VALUES(credential,w.id,l.id,revision,digest,label_value,'conversion_ingest',expiry,NULL,at_time);
  UPDATE linky_private.links SET version=l.version+1,updated_at=at_time WHERE id=l.id;
  RETURN linky_private._finish(w.id,key,'issue_conversion_credential',credential,fp,w.owner_key_version,
    pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'credentialId',credential,'revisionId',revision,'version',l.version+1),'owner',w.id,'conversion_credential',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private.owner_list_conversion_credentials(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; amount integer:=50; cursor_id uuid; rows jsonb; next_id uuid;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','linkId'],ARRAY['limit','after']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'),false);
  IF p_payload?'limit' THEN amount:=linky_private._integer(p_payload,'limit',1,100); END IF;
  IF p_payload?'after' AND p_payload->'after'<>'null'::jsonb THEN cursor_id:=linky_private._uuid(p_payload,'after'); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY id),'[]'::jsonb),(pg_catalog.array_agg(id ORDER BY id))[amount] INTO rows,next_id FROM (
    SELECT c.id,pg_catalog.jsonb_build_object('id',c.id,'linkId',c.link_id,'revisionId',c.revision_id,'label',c.label,'purpose',c.purpose,'expiresAt',c.expires_at,'revokedAt',c.revoked_at,'createdAt',c.created_at) item
    FROM linky_private.conversion_credentials c WHERE c.workspace_id=w.id AND c.link_id=l.id AND (cursor_id IS NULL OR c.id>cursor_id) ORDER BY c.id LIMIT amount
  ) selected;
  RETURN pg_catalog.jsonb_build_object('credentials',rows,'nextCursor',CASE WHEN pg_catalog.jsonb_array_length(rows)=amount THEN pg_catalog.to_jsonb(next_id) ELSE 'null'::jsonb END);
END $$;
CREATE FUNCTION linky_private.owner_revoke_conversion_credential(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; l linky_private.links; c linky_private.conversion_credentials; credential uuid; key uuid; fp text; old jsonb; at_time timestamptz;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId','mutationKey','linkId','credentialId','expectedVersion']);
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId')); l:=linky_private._link(w.id,linky_private._uuid(p_payload,'linkId'));
  key:=linky_private._uuid(p_payload,'mutationKey'); credential:=linky_private._uuid(p_payload,'credentialId'); fp:=linky_private._fingerprint('revoke_conversion_credential',p_payload);
  old:=linky_private._replay(w.id,key,'revoke_conversion_credential',fp); IF old IS NOT NULL THEN RETURN old; END IF;
  PERFORM linky_private._cas(l.version,linky_private._integer(p_payload,'expectedVersion',1,9007199254740991));
  SELECT * INTO c FROM linky_private.conversion_credentials x WHERE x.workspace_id=w.id AND x.link_id=l.id AND x.id=credential FOR UPDATE;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  at_time:=pg_catalog.clock_timestamp(); UPDATE linky_private.conversion_credentials SET revoked_at=COALESCE(c.revoked_at,at_time) WHERE id=c.id;
  UPDATE linky_private.links SET version=l.version+1,updated_at=at_time WHERE id=l.id;
  RETURN linky_private._finish(w.id,key,'revoke_conversion_credential',c.id,fp,w.owner_key_version,
    pg_catalog.jsonb_build_object('workspaceId',w.id,'linkId',l.id,'credentialId',c.id,'version',l.version+1),'owner',w.id,'conversion_credential',l.version,l.version+1,at_time);
EXCEPTION WHEN unique_violation THEN PERFORM linky_private._fail('linky_conflict');
END $$;
CREATE FUNCTION linky_private._conversion_credential(digest text,credential uuid) RETURNS linky_private.conversion_credentials
LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE hint linky_private.conversion_credentials; c linky_private.conversion_credentials; w linky_private.workspaces; l linky_private.links; at_time timestamptz;
BEGIN
  PERFORM linky_private._hash(digest);
  SELECT * INTO hint FROM linky_private.conversion_credentials x WHERE x.id=credential;
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_denied'); END IF;
  SELECT * INTO w FROM linky_private.workspaces x WHERE x.id=hint.workspace_id FOR SHARE;
  l:=linky_private._link(w.id,hint.link_id,false);
  SELECT * INTO c FROM linky_private.conversion_credentials x WHERE x.id=credential FOR SHARE;
  IF c.ingest_key_hash<>digest OR c.purpose<>'conversion_ingest' THEN PERFORM linky_private._fail('linky_denied'); END IF;
  IF w.state<>'active' THEN PERFORM linky_private._fail('linky_closed'); END IF;
  IF l.state<>'active' THEN PERFORM linky_private._fail('linky_inactive'); END IF;
  at_time:=pg_catalog.clock_timestamp();
  IF c.revoked_at IS NOT NULL THEN PERFORM linky_private._fail('linky_revoked'); END IF;
  IF c.expires_at<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  RETURN c;
END $$;
CREATE FUNCTION linky_private.conversion_ingest(p_ingest_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE c linky_private.conversion_credentials; r linky_private.redemption_receipts; e linky_private.conversion_events;
  key uuid; receipt uuid; event_kind text; amount bigint; denomination text; declared_time timestamptz; at_time timestamptz; fp text; replay boolean:=false;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['credentialId','receiptId','eventKey','kind','amountMinor','currency','declaredAt']);
  c:=linky_private._conversion_credential(p_ingest_hash,linky_private._uuid(p_payload,'credentialId'));
  receipt:=linky_private._uuid(p_payload,'receiptId'); key:=linky_private._uuid(p_payload,'eventKey'); event_kind:=linky_private._text(p_payload,'kind',20); declared_time:=linky_private._instant(p_payload,'declaredAt');
  IF event_kind NOT IN ('lead_declared','sale_declared') THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  IF p_payload->'amountMinor'<>'null'::jsonb THEN amount:=linky_private._integer(p_payload,'amountMinor',0,9007199254740991); END IF;
  IF p_payload->'currency'<>'null'::jsonb THEN denomination:=linky_private._text(p_payload,'currency',3); IF denomination !~ '^[A-Z]{3}$' THEN PERFORM linky_private._fail('linky_invalid'); END IF; END IF;
  IF (event_kind='lead_declared' AND (amount IS NOT NULL OR denomination IS NOT NULL)) OR (amount IS NULL)<>(denomination IS NULL) THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  SELECT * INTO r FROM linky_private.redemption_receipts x WHERE x.id=receipt AND (x.workspace_id,x.link_id,x.revision_id)=(c.workspace_id,c.link_id,c.revision_id);
  IF NOT FOUND THEN PERFORM linky_private._fail('linky_scope'); END IF;
  -- Same event identity across credential rotations; namespace independent of owner keys.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(c.workspace_id::text||':conversion:'||key::text,0));
  at_time:=pg_catalog.clock_timestamp(); IF c.expires_at<=at_time THEN PERFORM linky_private._fail('linky_expired'); END IF;
  fp:=linky_private._fingerprint('conversion_ingest',pg_catalog.jsonb_build_object('workspaceId',c.workspace_id,'linkId',c.link_id,'revisionId',c.revision_id,
    'receiptId',receipt,'kind',event_kind,'amountMinor',amount,'currency',denomination,'declaredEpoch',EXTRACT(epoch FROM declared_time)));
  SELECT * INTO e FROM linky_private.conversion_events x WHERE x.workspace_id=c.workspace_id AND x.event_key=key;
  IF FOUND THEN
    IF e.request_fingerprint<>fp THEN PERFORM linky_private._fail('linky_conflict'); END IF;
    replay:=true;
  ELSE
    INSERT INTO linky_private.conversion_events VALUES(pg_catalog.gen_random_uuid(),c.workspace_id,c.link_id,c.revision_id,r.id,c.id,key,event_kind,amount,denomination,declared_time,at_time,fp,r.campaign_snapshot) RETURNING * INTO e;
    PERFORM linky_private._audit(c.workspace_id,'conversion_ingest',c.id,NULL,'conversion_ingest','conversion_event',e.id,NULL,NULL,at_time);
  END IF;
  RETURN pg_catalog.jsonb_build_object('eventId',e.id,'workspaceId',e.workspace_id,'linkId',e.link_id,'revisionId',e.revision_id,'receiptId',e.receipt_id,'eventKey',e.event_key,'kind',e.kind,'acceptedAt',e.accepted_at,'replayed',replay);
END $$;

CREATE FUNCTION linky_private.owner_bulk_create_links(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; row_value jsonb; work jsonb:='[]'::jsonb; outcomes jsonb:='[]'::jsonb; ack jsonb;
  source_index integer; row_key uuid; link_id_value uuid; revision uuid; slug_value text; error_code text;
BEGIN
  -- Server-normalized rows repeat hostname/safety data absent from the 32 KiB wire DTO.
  IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  IF pg_catalog.pg_column_size(p_payload)>262144 OR NOT p_payload ?& ARRAY['workspaceId','rows']
    OR p_payload-ARRAY['workspaceId','rows']<>'{}'::jsonb THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'));
  IF pg_catalog.jsonb_typeof(p_payload->'rows') IS DISTINCT FROM 'array' OR pg_catalog.jsonb_array_length(p_payload->'rows') NOT BETWEEN 1 AND 50 THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  FOR row_value IN SELECT value FROM pg_catalog.jsonb_array_elements(p_payload->'rows') LOOP
    PERFORM linky_private._shape(row_value,ARRAY['sourceIndex','mutationKey','linkId','revisionId','slug','label','destination','campaign','safety']);
    source_index:=linky_private._integer(row_value,'sourceIndex',0,499); row_key:=linky_private._uuid(row_value,'mutationKey'); link_id_value:=linky_private._uuid(row_value,'linkId'); revision:=linky_private._uuid(row_value,'revisionId'); slug_value:=linky_private._text(row_value,'slug',96);
    IF slug_value !~ '^[A-Za-z0-9_-]{8,96}$' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
    row_value:=row_value||pg_catalog.jsonb_build_object('sourceIndex',source_index,'mutationKey',row_key,'linkId',link_id_value,'revisionId',revision);
    IF EXISTS(SELECT 1 FROM pg_catalog.jsonb_array_elements(work) x WHERE x->>'sourceIndex'=source_index::text OR x->>'mutationKey'=row_key::text OR x->>'linkId'=link_id_value::text OR x->>'revisionId'=revision::text OR x->>'slug'=slug_value) THEN PERFORM linky_private._fail('linky_conflict'); END IF;
    work:=work||pg_catalog.jsonb_build_array(row_value);
  END LOOP;
  -- Every batch acquires its complete key set in the same order, before row writes.
  FOR row_key IN SELECT (value->>'mutationKey')::uuid FROM pg_catalog.jsonb_array_elements(work) ORDER BY (value->>'mutationKey')::uuid LOOP
    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(w.id::text||row_key::text,0));
  END LOOP;
  FOR row_value IN SELECT value FROM pg_catalog.jsonb_array_elements(work) ORDER BY (value->>'linkId')::uuid LOOP
    error_code:=NULL; ack:=NULL;
    BEGIN
      ack:=linky_private.owner_create_link(p_owner_hash,(row_value-'sourceIndex')||pg_catalog.jsonb_build_object('workspaceId',w.id));
    EXCEPTION WHEN OTHERS THEN
      IF SQLSTATE='P0001' AND SQLERRM IN ('linky_invalid','linky_denied','linky_closed','linky_conflict','linky_scope','linky_expired','linky_revoked','linky_exhausted','linky_inactive','linky_immutable') THEN error_code:=SQLERRM;
      ELSIF SQLSTATE IN ('23505','23503','23514','22001') THEN error_code:='linky_conflict';
      ELSE error_code:='linky_unavailable'; END IF;
    END;
    outcomes:=outcomes||pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object('sourceIndex',(row_value->>'sourceIndex')::integer,'mutationKey',row_value->>'mutationKey','linkId',row_value->>'linkId','revisionId',row_value->>'revisionId',
      'status',CASE WHEN error_code IS NOT NULL THEN 'error' WHEN (ack->>'replayed')::boolean THEN 'replayed' ELSE 'committed' END,'version',ack->'version','error',error_code));
  END LOOP;
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY (value->>'sourceIndex')::integer),'[]'::jsonb) INTO outcomes FROM pg_catalog.jsonb_array_elements(outcomes);
  RETURN pg_catalog.jsonb_build_object('outcomes',outcomes);
END $$;

CREATE FUNCTION linky_private.owner_attribution_report(p_owner_hash text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE w linky_private.workspaces; start_at timestamptz; end_at timestamptz; amount integer:=1000; receipts jsonb; events jsonb;
  redemption_campaigns jsonb; declaration_campaigns jsonb; currencies jsonb; receipt_count integer; event_count integer;
  receipt_truncated boolean; event_truncated boolean; leads integer; sales integer; unknown_sales integer;
BEGIN
  PERFORM linky_private._shape(p_payload,ARRAY['workspaceId'],ARRAY['from','to','limit']); w:=linky_private._owner(p_owner_hash,linky_private._uuid(p_payload,'workspaceId'));
  end_at:=pg_catalog.clock_timestamp(); start_at:=end_at-interval '30 days';
  IF p_payload?'from' AND p_payload->'from'<>'null'::jsonb THEN start_at:=linky_private._instant(p_payload,'from'); END IF;
  IF p_payload?'to' AND p_payload->'to'<>'null'::jsonb THEN end_at:=linky_private._instant(p_payload,'to'); END IF;
  IF end_at<=start_at OR end_at-start_at>interval '366 days' THEN PERFORM linky_private._fail('linky_invalid'); END IF;
  IF p_payload?'limit' THEN amount:=linky_private._integer(p_payload,'limit',1,5000); END IF;
  SELECT COALESCE(pg_catalog.jsonb_agg(campaign_snapshot ORDER BY redeemed_at DESC,id DESC),'[]'::jsonb) INTO receipts FROM (
    SELECT x.id,x.redeemed_at,x.campaign_snapshot FROM linky_private.redemption_receipts x WHERE x.workspace_id=w.id AND x.redeemed_at>=start_at AND x.redeemed_at<end_at ORDER BY x.redeemed_at DESC,x.id DESC LIMIT amount+1
  ) bounded;
  receipt_truncated:=pg_catalog.jsonb_array_length(receipts)>amount;
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO receipts FROM pg_catalog.jsonb_array_elements(receipts) WITH ORDINALITY WHERE ordinality<=amount;
  receipt_count:=pg_catalog.jsonb_array_length(receipts);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('campaign',campaign,'count',total) ORDER BY campaign::text),'[]'::jsonb) INTO redemption_campaigns FROM (
    SELECT value campaign,pg_catalog.count(*) total FROM pg_catalog.jsonb_array_elements(receipts) GROUP BY value
  ) grouped;
  SELECT COALESCE(pg_catalog.jsonb_agg(item ORDER BY accepted_at DESC,id DESC),'[]'::jsonb) INTO events FROM (
    SELECT x.id,x.accepted_at,pg_catalog.jsonb_build_object('campaign',x.campaign_snapshot,'kind',x.kind,'amountMinor',x.amount_minor,'currency',x.currency) item
    FROM linky_private.conversion_events x WHERE x.workspace_id=w.id AND x.accepted_at>=start_at AND x.accepted_at<end_at ORDER BY x.accepted_at DESC,x.id DESC LIMIT amount+1
  ) bounded;
  event_truncated:=pg_catalog.jsonb_array_length(events)>amount;
  SELECT COALESCE(pg_catalog.jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO events FROM pg_catalog.jsonb_array_elements(events) WITH ORDINALITY WHERE ordinality<=amount;
  event_count:=pg_catalog.jsonb_array_length(events);
  SELECT pg_catalog.count(*) FILTER(WHERE value->>'kind'='lead_declared'),pg_catalog.count(*) FILTER(WHERE value->>'kind'='sale_declared'),pg_catalog.count(*) FILTER(WHERE value->>'kind'='sale_declared' AND value->'amountMinor'='null'::jsonb)
    INTO leads,sales,unknown_sales FROM pg_catalog.jsonb_array_elements(events);
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('campaign',campaign,'leads',lead_count,'sales',sale_count,'unknownValueSales',unknown_count) ORDER BY campaign::text),'[]'::jsonb) INTO declaration_campaigns FROM (
    SELECT value->'campaign' campaign,pg_catalog.count(*) FILTER(WHERE value->>'kind'='lead_declared') lead_count,pg_catalog.count(*) FILTER(WHERE value->>'kind'='sale_declared') sale_count,
      pg_catalog.count(*) FILTER(WHERE value->>'kind'='sale_declared' AND value->'amountMinor'='null'::jsonb) unknown_count FROM pg_catalog.jsonb_array_elements(events) GROUP BY value->'campaign'
  ) grouped;
  SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object('currency',denomination,'amountMinor',total::text,'sales',sale_count) ORDER BY denomination),'[]'::jsonb) INTO currencies FROM (
    SELECT value->>'currency' denomination,pg_catalog.sum((value->>'amountMinor')::numeric) total,pg_catalog.count(*) sale_count FROM pg_catalog.jsonb_array_elements(events)
    WHERE value->>'kind'='sale_declared' AND value->'amountMinor'<>'null'::jsonb GROUP BY value->>'currency'
  ) grouped;
  RETURN pg_catalog.jsonb_build_object('redemptions',pg_catalog.jsonb_build_object('count',receipt_count,'campaigns',redemption_campaigns,
    'coverage',pg_catalog.jsonb_build_object('kind','committed_redemptions','from',start_at,'to',end_at,'limit',amount,'recordCount',receipt_count,'truncated',receipt_truncated)),
    'declarations',pg_catalog.jsonb_build_object('total',event_count,'leads',leads,'sales',sales,'unknownValueSales',unknown_sales,'campaigns',declaration_campaigns,'currencies',currencies,
    'coverage',pg_catalog.jsonb_build_object('kind','accepted_conversion_declarations','from',start_at,'to',end_at,'limit',amount,'recordCount',event_count,'truncated',event_truncated)));
END $$;

ALTER TABLE linky_private.conversion_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE linky_private.conversion_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON linky_private.conversion_credentials,linky_private.conversion_events FROM PUBLIC,linky_runtime,linky_operator;
REVOKE ALL ON FUNCTION linky_private._conversion_credential_change(),linky_private._conversion_credential(text,uuid),
  linky_private.owner_issue_conversion_credential(text,jsonb),linky_private.owner_list_conversion_credentials(text,jsonb),linky_private.owner_revoke_conversion_credential(text,jsonb),
  linky_private.conversion_ingest(text,jsonb),linky_private.owner_bulk_create_links(text,jsonb),linky_private.owner_attribution_report(text,jsonb) FROM PUBLIC,linky_runtime,linky_operator;
GRANT EXECUTE ON FUNCTION linky_private.owner_issue_conversion_credential(text,jsonb),linky_private.owner_list_conversion_credentials(text,jsonb),linky_private.owner_revoke_conversion_credential(text,jsonb),
  linky_private.conversion_ingest(text,jsonb),linky_private.owner_bulk_create_links(text,jsonb),linky_private.owner_attribution_report(text,jsonb) TO linky_runtime;
COMMIT;
