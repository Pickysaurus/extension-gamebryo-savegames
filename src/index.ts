import { clearSavegames, setSavegamePath,
   setSavegames, showTransferDialog } from './actions/session';
import { sessionReducer } from './reducers/session';
import { ISavegame } from './types/ISavegame';
import {gameSupported, iniPath, mygamesPath, prefIniPath} from './util/gameSupport';
import refreshSavegames from './util/refreshSavegames';
import SavegameList from './views/SavegameList';

import * as Promise from 'bluebird';
import * as path from 'path';
import { fs, log, selectors, types, util } from 'vortex-api';
import IniParser, {IniFile, WinapiFormat} from 'vortex-parse-ini';

const parser = new IniParser(new WinapiFormat());
let fsWatcher: fs.FSWatcher;

function updateSaveSettings(store: Redux.Store<any>,
                            profileId: string): Promise<string> {
  const state: types.IState = store.getState();
  const profile = state.persistent.profiles[profileId];

  if (profile === undefined) {
    // how did we get here then???
    return Promise.reject(new util.ProcessCanceled('no current profile'));
  }

  const localSaves = util.getSafe(profile, ['features', 'local_saves'], false);
  const savePath = localSaves
            ? path.join('Saves', profile.id) + path.sep
            : 'Saves' + path.sep;

  const fullPath = mygamesPath(profile.gameId) + path.sep + savePath;
  return fs.ensureDirAsync(fullPath)
    .then(() => setSavePath(store, profile, savePath))
    .then(() => unsetInPrefs(profile))
    .then(() => fullPath);
}

function setSavePath(store: Redux.Store<any>,
                     profile: types.IProfile,
                     savePath: string): Promise<void> {
  const iniFilePath = iniPath(profile.gameId);
  return parser.read(iniFilePath)
    .then((iniFile: IniFile<any>) => {
      if (iniFile.data.General === undefined) {
        iniFile.data.General = {};
      }
      // TODO: we should provide a way for the user to set his own
      //   save path without overwriting it
      iniFile.data.General.SLocalSavePath = savePath;

      parser.write(iniFilePath, iniFile);

      store.dispatch(setSavegamePath(savePath));
      store.dispatch(clearSavegames());
    });
}

function unsetInPrefs(profile: types.IProfile): Promise<void> {
  const prefPath = prefIniPath(profile.gameId);
  if (prefPath === undefined) {
    return Promise.resolve();
  }

  return parser.read(prefPath)
    .then((iniFile: IniFile<any>) => {
      if ((iniFile.data.General === undefined)
          || (iniFile.data.General.SLocalSavePath === undefined)) {
        return;
      }
      iniFile.data.General.SLocalSavePath = undefined;

      parser.write(prefPath, iniFile);
    });
}

function updateSaves(store: Redux.Store<any>,
                     profileId: string,
                     savesPath: string): Promise<string[]> {
  const newSavegames: ISavegame[] = [];

  return refreshSavegames(savesPath, (save: ISavegame): void => {
    if (store.getState().session.saves[save.id] === undefined) {
      newSavegames.push(save);
    }
  })
  .then((failedReads: string[]) => Promise.resolve({ newSavegames, failedReads }))
  .then((result: { newSavegames: ISavegame[], failedReads: string[] }) => {
    const savesDict: { [id: string]: ISavegame } = {};
    result.newSavegames.forEach(
      (save: ISavegame) => { savesDict[save.id] = save; });

    store.dispatch(setSavegames(savesDict));
    return Promise.resolve(result.failedReads);
  });
}

function init(context): boolean {
  context.registerAction('savegames-icons', 200, 'transfer', {}, 'Transfer Savegames', () => {
    context.api.store.dispatch(showTransferDialog(true));
  });

  context.registerMainPage('savegame', 'Save Games', SavegameList, {
    hotkey: 'A',
    group: 'per-game',
    visible: () => gameSupported(selectors.activeGameId(context.api.store.getState())),
  });

  context.registerReducer(['session', 'saves'], sessionReducer);
  context.registerProfileFeature(
      'local_saves', 'boolean', 'savegame', 'Save Games', 'This profile has its own save games',
      () => gameSupported(selectors.activeGameId(context.api.store.getState())));

  context.once(() => {
    const store: Redux.Store<any> = context.api.store;

    context.api.setStylesheet('savegame-management',
                              path.join(__dirname, 'savegame_management.scss'));

    context.api.events.on('profile-did-change', (profileId: string) => {
      const profile: types.IProfile =
          util.getSafe(store.getState(),
                       ['persistent', 'profiles', profileId], undefined);
      if ((profile === undefined) || !gameSupported(profile.gameId)) {
        return;
      }
      let savesPath: string;
      updateSaveSettings(store, profileId)
        .then(savesPathIn => {
          savesPath = savesPathIn;
          return updateSaves(store, profileId, savesPath);
        })
        .then((failedReads: string[]) => {
          if (failedReads.length > 0) {
            context.api.showErrorNotification('Some saves couldn\'t be read',
              failedReads.join('\n'), { allowReport: false });
          }

          if (fsWatcher !== undefined) {
            fsWatcher.close();
          }
          const update = new util.Debouncer(() => {
            return updateSaves(store, profileId, savesPath)
              .then((failedReadsInner: string[]) => {
                if (failedReadsInner.length > 0) {
                  context.api.showErrorNotification('Some saves couldn\'t be read',
                    failedReadsInner.join('\n'), { allowReport: false });
                }
            });
          }, 1000);
          try {
            fsWatcher =
                fs.watch(savesPath, {}, (evt: string, filename: string) => {
                  update.schedule(undefined);
                });
            fsWatcher.on('error', error => {
              // going by the amount of feedback on this it appears like it's a very common thing to
              // delete your savegame directory...
              log('warn', 'failed to watch savegame directory', { savesPath, error });
              fsWatcher.close();
              fsWatcher = undefined;
            });
          } catch (err) {
            context.api.showErrorNotification('Can\'t watch saves directory for changes', {
              path: savesPath, error: err.message,
            });
          }
        });
    });
  });

  return true;
}

export default init;
