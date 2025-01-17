import { createUILockAction } from "@/store/ui";
import {
  AudioItem,
  ProjectGetters,
  ProjectActions,
  ProjectMutations,
  VoiceVoxStoreOptions,
} from "@/store/type";

import Ajv, { JTDDataType } from "ajv/dist/jtd";
import { AccentPhrase } from "@/openapi";

const DEFAULT_SAMPLING_RATE = 24000;

export const projectStore: VoiceVoxStoreOptions<
  ProjectGetters,
  ProjectActions,
  ProjectMutations
> = {
  getters: {
    PROJECT_NAME(state) {
      return state.projectFilePath !== undefined
        ? window.electron.getBaseName({ filePath: state.projectFilePath })
        : undefined;
    },
  },

  mutations: {
    SET_PROJECT_FILEPATH(state, { filePath }: { filePath?: string }) {
      state.projectFilePath = filePath;
    },
  },

  actions: {
    CREATE_NEW_PROJECT: createUILockAction(
      async (context, { confirm }: { confirm?: boolean }) => {
        if (
          confirm !== false &&
          !(await window.electron.showConfirmDialog({
            title: "警告",
            message:
              "保存されていないプロジェクトの変更は破棄されます。\n" +
              "よろしいですか？",
          }))
        ) {
          return;
        }

        await context.dispatch("REMOVE_ALL_AUDIO_ITEM", undefined);

        const audioItem: AudioItem = { text: "", speaker: 0 };
        await context.dispatch("REGISTER_AUDIO_ITEM", {
          audioItem,
        });

        context.commit("SET_PROJECT_FILEPATH", { filePath: undefined });
      }
    ),
    LOAD_PROJECT_FILE: createUILockAction(
      async (
        context,
        { filePath, confirm }: { filePath?: string; confirm?: boolean }
      ) => {
        if (!filePath) {
          // Select and load a project File.
          const ret = await window.electron.showProjectLoadDialog({
            title: "プロジェクトファイルの選択",
          });
          if (ret == undefined || ret?.length == 0) {
            return;
          }
          filePath = ret[0];
        }

        const projectFileErrorMsg = `VOICEVOX Project file "${filePath}" is a invalid file.`;

        try {
          const buf = await window.electron.readFile({ filePath });
          const text = new TextDecoder("utf-8").decode(buf).trim();
          const obj = JSON.parse(text);

          // appVersion Validation check
          if (!("appVersion" in obj && typeof obj.appVersion === "string")) {
            throw new Error(
              projectFileErrorMsg +
                " The appVersion of the project file should be string"
            );
          }
          const appVersionList = versionTextParse(obj.appVersion);
          const nowAppInfo = await window.electron.getAppInfos();
          const nowAppVersionList = versionTextParse(nowAppInfo.version);
          if (appVersionList == null || nowAppVersionList == null) {
            throw new Error(
              projectFileErrorMsg +
                ' An invalid appVersion format. The appVersion should be in the format "%d.%d.%d'
            );
          }

          // Migration
          if (appVersionList < [0, 4, 0]) {
            for (const audioItemsKey in obj.audioItems) {
              if ("charactorIndex" in obj.audioItems[audioItemsKey]) {
                obj.audioItems[audioItemsKey].characterIndex =
                  obj.audioItems[audioItemsKey].charactorIndex;
                delete obj.audioItems[audioItemsKey].charactorIndex;
              }
            }
            for (const audioItemsKey in obj.audioItems) {
              if (obj.audioItems[audioItemsKey].query != null) {
                obj.audioItems[audioItemsKey].query.volumeScale = 1;
                obj.audioItems[audioItemsKey].query.prePhonemeLength = 0.1;
                obj.audioItems[audioItemsKey].query.postPhonemeLength = 0.1;
                obj.audioItems[audioItemsKey].query.outputSamplingRate =
                  DEFAULT_SAMPLING_RATE;
              }
            }
          }

          if (appVersionList < [0, 5, 0]) {
            for (const audioItemsKey in obj.audioItems) {
              const audioItem = obj.audioItems[audioItemsKey];
              if (audioItem.query != null) {
                audioItem.query.outputStereo = false;
                for (const accentPhrase of audioItem.query.accentPhrases) {
                  if (accentPhrase.pauseMora) {
                    accentPhrase.pauseMora.vowelLength = 0;
                  }
                  for (const mora of accentPhrase.moras) {
                    if (mora.consonant) {
                      mora.consonantLength = 0;
                    }
                    mora.vowelLength = 0;
                  }
                }
              }

              // set phoneme length
              await context
                .dispatch("FETCH_MORA_DATA", {
                  accentPhrases: audioItem.query!.accentPhrases,
                  speaker: audioItem.speaker!,
                })
                .then((accentPhrases: AccentPhrase[]) => {
                  accentPhrases.forEach((newAccentPhrase, i) => {
                    const oldAccentPhrase = audioItem.query.accentPhrases[i];
                    if (newAccentPhrase.pauseMora) {
                      oldAccentPhrase.pauseMora.vowelLength =
                        newAccentPhrase.pauseMora.vowelLength;
                    }
                    newAccentPhrase.moras.forEach((mora, j) => {
                      if (mora.consonant) {
                        oldAccentPhrase.moras[j].consonantLength =
                          mora.consonantLength;
                      }
                      oldAccentPhrase.moras[j].vowelLength = mora.vowelLength;
                    });
                  });
                });
            }
          }

          // Validation check
          const ajv = new Ajv();
          const validate = ajv.compile(projectSchema);
          if (!validate(obj)) {
            throw validate.errors;
          }
          if (!obj.audioKeys.every((audioKey) => audioKey in obj.audioItems)) {
            throw new Error(
              projectFileErrorMsg +
                " Every audioKey in audioKeys should be a key of audioItems"
            );
          }
          if (
            !obj.audioKeys.every(
              (audioKey) => obj.audioItems[audioKey].speaker != undefined
            )
          ) {
            throw new Error(
              'Every audioItem should have a "speaker" attribute.'
            );
          }

          if (
            confirm !== false &&
            !(await window.electron.showConfirmDialog({
              title: "警告",
              message:
                "プロジェクトをロードすると現在のプロジェクトは破棄されます。\n" +
                "よろしいですか？",
            }))
          ) {
            return;
          }
          await context.dispatch("REMOVE_ALL_AUDIO_ITEM", undefined);

          const { audioItems, audioKeys } = obj as ProjectType;

          let prevAudioKey = undefined;
          for (const audioKey of audioKeys) {
            const audioItem = audioItems[audioKey];
            prevAudioKey = await context.dispatch("REGISTER_AUDIO_ITEM", {
              prevAudioKey,
              audioItem,
            });
          }
          context.commit("SET_PROJECT_FILEPATH", { filePath });
        } catch (err) {
          window.electron.logError(err);
          const message = (() => {
            if (typeof err === "string") return err;
            if (!(err instanceof Error)) return "エラーが発生しました。";
            if (err.message.startsWith(projectFileErrorMsg))
              return "ファイルフォーマットが正しくありません。";
            return err.message;
          })();
          await window.electron.showErrorDialog({
            title: "エラー",
            message,
          });
        }
      }
    ),
    SAVE_PROJECT_FILE: createUILockAction(
      async (context, { overwrite }: { overwrite?: boolean }) => {
        let filePath = context.state.projectFilePath;
        if (!overwrite || !filePath) {
          // Write the current status to a project file.
          const ret = await window.electron.showProjectSaveDialog({
            title: "プロジェクトファイルの選択",
          });
          if (ret == undefined) {
            return;
          }
          filePath = ret;
        }
        const appInfos = await window.electron.getAppInfos();
        const { audioItems, audioKeys } = context.state;
        const projectData: ProjectType = {
          appVersion: appInfos.version,
          audioKeys,
          audioItems,
        };
        const buf = new TextEncoder().encode(
          JSON.stringify(projectData)
        ).buffer;
        window.electron.writeFile({ filePath, buffer: buf });
        if (!context.state.projectFilePath) {
          context.commit("SET_PROJECT_FILEPATH", { filePath });
        }
        return;
      }
    ),
  },
};

const moraSchema = {
  properties: {
    text: { type: "string" },
    vowel: { type: "string" },
    vowelLength: { type: "float32" },
    pitch: { type: "float32" },
  },
  optionalProperties: {
    consonant: { type: "string" },
    consonantLength: { type: "float32" },
  },
} as const;

const accentPhraseSchema = {
  properties: {
    moras: {
      elements: moraSchema,
    },
    accent: { type: "int32" },
  },
  optionalProperties: {
    pauseMora: moraSchema,
  },
} as const;

const audioQuerySchema = {
  properties: {
    accentPhrases: {
      elements: accentPhraseSchema,
    },
    speedScale: { type: "float32" },
    pitchScale: { type: "float32" },
    intonationScale: { type: "float32" },
    volumeScale: { type: "float32" },
    prePhonemeLength: { type: "float32" },
    postPhonemeLength: { type: "float32" },
    outputSamplingRate: { type: "int32" },
    outputStereo: { type: "boolean" },
  },
  optionalProperties: {
    kana: { type: "string" },
  },
} as const;

const audioItemSchema = {
  properties: {
    text: { type: "string" },
  },
  optionalProperties: {
    speaker: { type: "int32" },
    query: audioQuerySchema,
  },
} as const;

export const projectSchema = {
  properties: {
    appVersion: { type: "string" },
    audioKeys: {
      // description: "Attribute keys of audioItems.",
      elements: { type: "string" },
    },
    audioItems: {
      // description: "VOICEVOX states per cell",
      values: audioItemSchema,
    },
  },
} as const;

export type LatestProjectType = JTDDataType<typeof projectSchema>;
interface ProjectType {
  appVersion: string;
  audioKeys: string[];
  audioItems: Record<string, AudioItem>;
}

export type VersionType = [number, number, number];

const versionTextParse = (appVersionText: string): VersionType | undefined => {
  const textArray = appVersionText.split(".");
  if (textArray.length !== 3) return undefined;
  const appVersion = textArray.map(Number) as VersionType;
  if (!appVersion.every((item) => Number.isInteger(item))) return undefined;
  return appVersion;
};
