//! 웹 actor 사이의 workspace + UI migration protocol이다.

use super::*;
use crate::native_ui::{NativeUiMigrationRegistration, NativeUiMigrationTargetRegistration};

pub(super) struct WebMigrationSourceState {
    ticket: u64,
    registration: u64,
    revision: u64,
    capture: NativeUiCapture,
    proof: NativeUiMigrationRegistration,
}

pub(super) enum WebMigrationTargetState {
    Building {
        ticket: u64,
        registration: u64,
        revision: u64,
        metadata: JsString,
        _memory: MemoryGroup,
    },
    Importing {
        ticket: u64,
        registration: u64,
        revision: u64,
        metadata: JsString,
        import: Box<NativeUiImport>,
        proof: NativeUiMigrationTargetRegistration,
        publication: Option<Box<PreparedPublication>>,
    },
}

fn migration_identity(args: &[JsValue], offset: usize) -> Result<(u64, u64, u64), JsError> {
    let ticket = exact_u64(argument(args, offset))
        .filter(|value| *value != 0)
        .ok_or_else(|| range_error("Web migration workspace ticket"))?;
    let registration = exact_u64(argument(args, offset + 1))
        .filter(|value| *value != 0)
        .ok_or_else(|| range_error("Web migration workspace registration"))?;
    let revision = exact_u64(argument(args, offset + 2))
        .filter(|value| *value != 0)
        .ok_or_else(|| range_error("Web migration source revision"))?;
    Ok((ticket, registration, revision))
}

fn check_ingestion_safe_point(chart: &NativeChart) -> Result<(), JsError> {
    let value = match chart.ingestion_owner().stats() {
        Ok(value) => value,
        Err(error) if error.code() == "NOT_CONFIGURED" => return Ok(()),
        Err(error) => return Err(ingestion_error(error)),
    };
    let state = field(&value, "state");
    let pending = field(&value, "pendingEvents");
    if !matches!(state, Some(JsValue::String(value)) if value == &key("paused"))
        || !matches!(pending, Some(JsValue::Number(value)) if *value == 0.0)
    {
        return Err(ordinary_error(
            "Web migration requires paused empty ingestion",
        ));
    }
    Ok(())
}

fn workspace_core(restored: RestoredWorkspace) -> Result<(NativePreparedCore, JsValue), JsError> {
    let RestoredWorkspace {
        data,
        model,
        indicators,
        drawings,
        series_caches,
        symbol,
        ingestion_document,
        ingestion_memory,
        memory,
        plan,
        ..
    } = restored;
    let mut owner = IngestionOwner::new(data, NumberDialect::PLATFORM);
    if let Some(document) = ingestion_document {
        let stats = owner
            .load(&JsValue::String(document))
            .map_err(ingestion_error)?;
        if !matches!(field(&stats, "pendingEvents"), Some(JsValue::Number(value)) if *value == 0.0)
            || !matches!(field(&stats, "state"), Some(JsValue::String(value)) if value == &key("paused"))
        {
            owner.dispose();
            return Err(ordinary_error(
                "Web migration target ingestion is not paused and empty",
            ));
        }
    }
    drop((drawings, symbol, ingestion_memory, memory));
    Ok((
        NativePreparedCore {
            owner,
            model,
            indicators,
            caches: series_caches,
            prepared_input: JsValue::Undefined,
        },
        plan.to_value(),
    ))
}

impl NativeRuntime {
    pub(super) fn web_migration_call(
        &mut self,
        name: &str,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<NativeRuntimeResult, JsError> {
        match name {
            "web.migrationSourceBegin" => {
                if self.web_migration_source.is_some() {
                    return Err(ordinary_error("Web migration source busy"));
                }
                let chart = current_chart(context)?;
                check_ingestion_safe_point(chart)?;
                let value = self.workspace_source_begin(args, context, scope)?;
                Ok(NativeRuntimeResult::value(value))
            }
            "web.migrationSourceStep" => Ok(NativeRuntimeResult::value(
                self.workspace_source_step(args, context, scope)?,
            )),
            "web.migrationSourceUiBegin" => {
                let value = self.web_migration_source_ui_begin(args, context, scope)?;
                Ok(NativeRuntimeResult::value(value))
            }
            "web.migrationSourceUiNext" => Ok(NativeRuntimeResult::value(
                self.web_migration_source_ui_next(args, context)?,
            )),
            "web.migrationSourceCheck" => Ok(NativeRuntimeResult::value(
                self.web_migration_source_check(args, context)?,
            )),
            "web.migrationSourceFinish" => Ok(NativeRuntimeResult::value(
                self.web_migration_source_finish(args, context)?,
            )),
            "web.migrationSourceAbort" => Ok(NativeRuntimeResult::value(
                self.web_migration_source_abort(args, context)?,
            )),
            "web.migrationTargetCreate" => Ok(NativeRuntimeResult::value(
                self.web_migration_target_create(args, context, scope)?,
            )),
            "web.migrationTargetStart" => {
                Ok(NativeRuntimeResult::value(self.async_start(context)?))
            }
            "web.migrationTargetStep" => Ok(NativeRuntimeResult::value(
                self.async_step(args, context, scope)?,
            )),
            "web.migrationTargetUiBegin" => Ok(NativeRuntimeResult::value(
                self.web_migration_target_ui_begin(args, context, scope)?,
            )),
            "web.migrationTargetUiChunk" => Ok(NativeRuntimeResult::value(
                self.web_migration_target_ui_chunk(args, scope)?,
            )),
            "web.migrationTargetUiFinish" => self.web_migration_target_ui_finish(args, context),
            "web.migrationTargetAbort" => Ok(NativeRuntimeResult::value(
                self.web_migration_target_abort()?,
            )),
            _ => Err(type_error("Unknown web migration operation")),
        }
    }

    fn web_migration_source_ui_begin(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.web_migration_source.is_some() {
            return Err(ordinary_error("Web migration UI source busy"));
        }
        let ticket = exact_u64(argument(args, 0))
            .filter(|value| *value != 0)
            .ok_or_else(|| range_error("Web migration workspace ticket"))?;
        let revision = exact_u64(argument(args, 1))
            .filter(|value| *value != 0)
            .ok_or_else(|| range_error("Web migration source revision"))?;
        let (registration, metadata) = {
            let row = self
                .workspace_source
                .as_ref()
                .filter(|row| row.ticket == ticket)
                .ok_or_else(|| ordinary_error("Workspace source ticket missing/released"))?;
            let registration = row
                .registration
                .ok_or_else(|| ordinary_error("Web migration workspace registration missing"))?;
            if revision as f64 != row.revision
                || row.source.buffers().is_none()
                || row.source.metadata_json().is_none()
            {
                return Err(ordinary_error(
                    "Web migration workspace source is not ready",
                ));
            }
            (
                registration,
                row.source
                    .metadata_json()
                    .expect("checked")
                    .try_clone_scoped(scope)
                    .map_err(|failure| failure.into_js_error())?,
            )
        };
        self.workspace_source_check(
            &[
                JsValue::Number(ticket as f64),
                JsValue::Number(revision as f64),
            ],
            context,
        )?;
        let (chart, input, size, _) = current_parts(context)?;
        let capture = NativeUiCapture::new_migration(chart, input, size, NumberDialect::PLATFORM)?;
        let proof = capture.register_migration(ticket, registration, revision, &metadata)?;
        let (header, header_memory) = capture.header_json_accounted()?.into_parts();
        scope
            .absorb_persistent(header_memory)
            .map_err(|failure| failure.into_js_error())?;
        let description = proof.to_value_scoped(scope)?;
        self.web_migration_source = Some(WebMigrationSourceState {
            ticket,
            registration,
            revision,
            capture,
            proof,
        });
        Ok(object([
            ("header", JsValue::String(header)),
            ("description", description),
        ]))
    }

    fn web_migration_source_ui_next(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let ticket = exact_u64(argument(args, 0));
        let (source_ticket, source_revision) = self
            .web_migration_source
            .as_ref()
            .filter(|state| Some(state.ticket) == ticket)
            .map(|state| (state.ticket, state.revision))
            .ok_or_else(|| ordinary_error("Web migration UI source missing"))?;
        self.workspace_source_check(
            &[
                JsValue::Number(source_ticket as f64),
                JsValue::Number(source_revision as f64),
            ],
            context,
        )?;
        let state = self
            .web_migration_source
            .as_mut()
            .expect("validated migration source");
        Ok(JsValue::String(state.capture.next_chunk()?))
    }

    fn web_migration_source_check(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let (ticket, registration, revision) = migration_identity(args, 0)?;
        let valid = self
            .web_migration_source
            .as_ref()
            .filter(|state| {
                state.ticket == ticket
                    && state.registration == registration
                    && state.revision == revision
            })
            .is_some();
        if !valid {
            return Err(ordinary_error("Web migration UI source missing"));
        }
        self.workspace_source_check(
            &[
                JsValue::Number(ticket as f64),
                JsValue::Number(revision as f64),
            ],
            context,
        )?;
        let state = self
            .web_migration_source
            .as_ref()
            .expect("validated migration source");
        let metadata = self
            .workspace_source
            .as_ref()
            .filter(|row| row.ticket == ticket)
            .and_then(|row| row.source.metadata_json())
            .ok_or_else(|| ordinary_error("Web migration workspace source is not ready"))?;
        let (chart, input, size, _) = current_parts(context)?;
        state
            .capture
            .check_migration(&state.proof, metadata, chart, input, size)?;
        if !state.capture.complete() {
            return Err(ordinary_error(
                "Web migration UI source transfer incomplete",
            ));
        }
        Ok(JsValue::Bool(true))
    }

    fn web_migration_source_finish(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        self.web_migration_source_check(args, context)?;
        let (ticket, _, revision) = migration_identity(args, 0)?;
        let receipt = self.workspace_source_finish(
            &[
                JsValue::Number(ticket as f64),
                JsValue::Number(revision as f64),
            ],
            context,
        )?;
        self.web_migration_source = None;
        Ok(receipt)
    }

    fn web_migration_source_abort(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<JsValue, JsError> {
        let ticket = exact_u64(argument(args, 0));
        let removed_ui = self
            .web_migration_source
            .as_ref()
            .is_some_and(|state| Some(state.ticket) == ticket);
        let removed_workspace = self
            .workspace_source
            .as_ref()
            .is_some_and(|row| Some(row.ticket) == ticket);
        if removed_ui {
            self.web_migration_source = None;
        }
        if removed_workspace {
            self.drop_workspace_source(context, ticket);
        }
        Ok(JsValue::Bool(removed_ui || removed_workspace))
    }

    fn web_migration_target_create(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        if self.web_migration_target.is_some() {
            return Err(ordinary_error("Web migration target busy"));
        }
        let metadata = string_scoped(argument(args, 0), "Workspace metadata", scope)?;
        let (ticket, registration, revision) = migration_identity(args, 1)?;
        let context_memory = self.memory.clone();
        let mut retained_scope = context_memory.scope();
        let retained_metadata = metadata
            .try_clone_scoped(&mut retained_scope)
            .map_err(|failure| failure.into_js_error())?;
        let retained_memory = retained_scope
            .split_persistent(js_string_heap_bytes(&retained_metadata))
            .map_err(|failure| failure.into_js_error())?;
        let value = self.workspace_target_create(
            std::slice::from_ref(&JsValue::String(metadata)),
            context,
            scope,
        )?;
        self.web_migration_target = Some(WebMigrationTargetState::Building {
            ticket,
            registration,
            revision,
            metadata: retained_metadata,
            _memory: retained_memory,
        });
        Ok(value)
    }

    fn web_migration_target_ui_begin(
        &mut self,
        args: &[JsValue],
        _context: &mut RuntimeContext<'_>,
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let description = argument(args, 0)
            .try_clone_scoped(scope)
            .map_err(|failure| failure.into_js_error())?;
        let header = string_scoped(argument(args, 1), "Web migration UI header", scope)?;
        let building = self
            .web_migration_target
            .take()
            .ok_or_else(|| ordinary_error("Web migration target missing"))?;
        let WebMigrationTargetState::Building {
            ticket,
            registration,
            revision,
            metadata,
            _memory,
        } = building
        else {
            self.web_migration_target = Some(building);
            return Err(ordinary_error("Web migration target UI already started"));
        };
        let prepared = self.prepared.take();
        let Some(PreparedTarget::Workspace(mut target)) = prepared else {
            self.prepared = prepared;
            self.web_migration_target = Some(WebMigrationTargetState::Building {
                ticket,
                registration,
                revision,
                metadata,
                _memory,
            });
            return Err(ordinary_error("Web migration workspace target missing"));
        };
        let restored = match target.finish() {
            Ok(restored) => restored,
            Err(error) => {
                self.prepared = Some(PreparedTarget::Workspace(target));
                self.web_migration_target = Some(WebMigrationTargetState::Building {
                    ticket,
                    registration,
                    revision,
                    metadata,
                    _memory,
                });
                return Err(error);
            }
        };
        let (core, _plan) = workspace_core(restored)?;
        let memory = core.owner.data().store().memory_context().clone();
        let mut import = Box::new(NativeUiImport::new_pending(
            &header,
            NumberDialect::PLATFORM,
            memory,
        )?);
        let proof = import.register_migration_target(
            &description,
            ticket,
            registration,
            revision,
            &metadata,
        )?;
        import.install_core(core, NativeUiFinishMode::Migration)?;
        self.web_migration_target = Some(WebMigrationTargetState::Importing {
            ticket,
            registration,
            revision,
            metadata,
            import,
            proof,
            publication: None,
        });
        Ok(JsValue::Bool(true))
    }

    fn web_migration_target_ui_chunk(
        &mut self,
        args: &[JsValue],
        scope: &mut MemoryScope,
    ) -> Result<JsValue, JsError> {
        let text = string_scoped(argument(args, 0), "Web migration UI chunk", scope)?;
        let Some(WebMigrationTargetState::Importing { import, .. }) =
            self.web_migration_target.as_mut()
        else {
            return Err(ordinary_error("Web migration UI target missing"));
        };
        import.chunk(&text)?;
        Ok(JsValue::Bool(true))
    }

    fn web_migration_target_ui_finish(
        &mut self,
        args: &[JsValue],
        context: &mut RuntimeContext<'_>,
    ) -> Result<NativeRuntimeResult, JsError> {
        let (ticket, registration, revision) = migration_identity(args, 0)?;
        let state = self
            .web_migration_target
            .as_mut()
            .ok_or_else(|| ordinary_error("Web migration UI target missing"))?;
        let WebMigrationTargetState::Importing {
            ticket: expected_ticket,
            registration: expected_registration,
            revision: expected_revision,
            metadata,
            import,
            proof,
            publication,
        } = state
        else {
            return Err(ordinary_error("Web migration UI target missing"));
        };
        if (ticket, registration, revision)
            != (*expected_ticket, *expected_registration, *expected_revision)
        {
            return Err(ordinary_error("Web migration UI target is stale"));
        }
        if publication.is_none() {
            *publication = Some(Box::new(import.finish_migration(
                proof,
                ticket,
                registration,
                revision,
                metadata,
            )?));
        }
        publication
            .as_mut()
            .expect("migration publication retained")
            .finalize_host_state(context.host)?;
        let publication = *publication.take().expect("finalized migration publication");
        self.web_migration_target = None;
        Ok(NativeRuntimeResult::publication(
            object([
                ("schema", text("aster.web-ui-migration-ready")),
                ("version", JsValue::Number(1.0)),
                ("status", text("target-ready")),
            ]),
            publication,
        ))
    }

    fn web_migration_target_abort(&mut self) -> Result<JsValue, JsError> {
        let existed = self.web_migration_target.take().is_some();
        if matches!(self.prepared, Some(PreparedTarget::Workspace(_))) {
            self.workspace_target_dispose();
        }
        Ok(JsValue::Bool(existed))
    }
}
